const _ = require('lodash');
const atob = require('atob');
const fs = require('fs');
const inquirer = require('inquirer');
const path = require('path');
const ora = require('ora');


const AuthFetcher = require('./lib/googleAPIWrapper');
const { time } = require('console');
let pageCounter = 1;

let messageIds = [];
let gmail;
String.prototype.replaceAll = function (search, replacement) {
  var target = this;
  return target.split(search).join(replacement);
}

const spinner = ora('Reading 1 page');
AuthFetcher.getAuthAndGmail(main);

/**
 * Lists the labels in the user's account.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
function listLabels(auth, gmail) {
  return new Promise((resolve, reject) => {
    gmail.users.labels.list({
      auth: auth,
      userId: 'me',
    }, (err, response) => {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      resolve(response);
    });
  })
}

function main(auth, gmailInstance) {
  let labels;
  let coredata = {};
  let workflow;
  gmail = gmailInstance;
  if (detectCommandOptions()) {
    workflow = scanForLabelOption;
  } else {
    workflow = defaultBehaviour;
  }
  workflow(auth, gmail, coredata)
    .then((mailList) => {
      coredata.mailList = mailList;
      return fetchMailsByMailIds(auth, mailList);
    })
    .then((mails) => {
      coredata.attachments = pluckAllAttachments(mails);
      return fetchAndSaveAttachments(auth, coredata.attachments);
    })
    .then(() => {
      spinner.stop()
      console.log('Done');
    })
    .catch((e) => console.log(e));
}

const detectCommandOptions = () => process.argv.length > 2;

const defaultBehaviour = (auth, gmail, coredata) => {
  return askForFilter()
    .then((option) => {
      if (option === 'label') {
        return listLabels(auth, gmail)
          .then((response) => {
            labels = response.data.labels;
            return labels;
          })
          .then(askForLabel)
          .then((selectedLabel) => {
            coredata.label = selectedLabel;
            spinner.start()
            return getListOfMailIdByLabel(auth, coredata.label.id, 200);
          });
      } else if (option === 'label') {
        return askForMail()
          .then((mailId) => {
            spinner.start()
            return getListOfMailIdByFromId(auth, mailId, 50);
          });
      } else {
        spinner.start()
        return getAllMails(auth, 500)
      }
    });
};

const scanForLabelOption = (auth, gmail) => {
  return new Promise((resolve, reject) => {
    const paramsNumber = process.argv.length;
    if (paramsNumber == 4) {
      const optionName = process.argv[2];
      if (optionName === '--label') {
        resolve(process.argv[3]);
      }
    }
    reject("WARNING: expected --label LABEL_NAME option")
  })
    .then(labelName => {
      return listLabels(auth, gmail)
        .then(response => {
          const labelObj = _.find(response.data.labels, l => l.name === labelName);
          return getListOfMailIdByLabel(auth, labelObj.id, 200);
        });
    });
};

async function fetchAndSaveAttachments(auth, attachments) {
  let results = [];
  let promises = [];
  let counter = 0;
  let processed = 0;
  spinner.text = "Fetching attachment from mails"
  for (index in attachments) {
    if (attachments[index].id) {
      promises.push(fetchAndSaveAttachment(auth, attachments[index]));
      counter++;
      processed++;
      if (counter === 100) {
        attachs = await Promise.all(promises);
        _.merge(results, attachs);
        promises = [];
        counter = 0;
        spinner.text = processed + " attachemets are saved"
      }
    }
  }
  attachs = await Promise.all(promises);
  _.merge(results, attachs);
  return results;
}

function fetchAndSaveAttachment(auth, attachment) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.attachments.get({
      auth: auth,
      userId: 'me',
      messageId: attachment.mailId,
      id: attachment.id
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      if (!response) {
        console.log('Empty response: ' + response);
        reject(response);
      }
      var data = response.data.data.replaceAll('-', '+');
      data = data.replaceAll('_', '/');
      var content = fixBase64(data);
      resolve(content);
    });
  })
    .then((content) => {
      
      var re = /[^< ]+(?=>)/g;
      var dir = 'files/'+attachment.adress.match(re)[0].replace(/[^a-zA-Z0-9]/g,'_');
      if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
      }
      var fileName = path.resolve(__dirname, dir, attachment.name.replace(/[^a-zA-Z0-9]/g,'_'));
      return isFileExist(fileName)
        .then((isExist) => {
          if (isExist) {
            return getNewFileName(fileName);
          }
          return fileName;
        })
        .then((availableFileName) => {
          return saveFile(availableFileName, content);
        })
        .catch(e => {
          console.log(e);
          console.log(dir);
          console.log(attachment.name.replace(/[^a-zA-Z0-9]/g,'_'));
        });
    })
}

function isFileExist(fileName) {
  return new Promise((resolve, reject) => {
    fs.stat(fileName, (err) => {
      if (err) {
        resolve(false);
      }
      resolve(true);
    })
  });
}

function getNewFileName(fileName) {
  return fileName.split('.')[0] + ' (' + Date.now() + ').' + fileName.split('.')[1];
}

function saveFile(fileName, content) {
  return new Promise((resolve, reject) => {
    fs.writeFile(fileName, content, function (err) {
      if (err) {
        reject(err);
      }
      resolve(`${fileName} file was saved!`);
    });
  });
}

function pluckAllAttachments(mails) {
  return _.compact(_.flatten(_.map(mails, (m) => {
    if (!m.data || !m.data.payload || !m.data.payload.parts) {
      return undefined;
    }
    return _.map(m.data.payload.parts, (p) => {
      if (!p.body || !p.body.attachmentId) {
        return undefined;
      }
      //console.log(m.data.id);
      //console.log(m.data.payload.headers);
      const adress = m.data.payload.headers.filter(header => header.name == 'From')[0];
      //console.log(adress.value);
      const attachment = {
        mailId: m.data.id,
        name: p.filename,
        id: p.body.attachmentId,
        adress:adress.value
      };
      return attachment;
    })
  })));
}

function askForLabel(labels) {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'label',
      message: 'Choose label for filter mails:',
      choices: _.map(labels, 'name'),
      filter: val => _.find(labels, l => l.name === val)
    }
  ])
    .then(answers => answers.label);
}

function askForFilter(labels) {
  return inquirer.prompt([
    {
      type: 'list',
      name: 'option',
      message: 'How do you like to filter',
      choices: ['Using from email Id', 'Using label', "All"],
      filter: val => {
        if (val === 'Using from email Id') {
          return 'from';
        } else if (val === 'Using label') {
          return 'label';
        } else {
          return 'all'
        }
      }
    }
  ])
    .then(answers => answers.option);
}

function askForMail() {
  return inquirer.prompt([
    {
      type: 'input',
      name: 'from',
      message: 'Enter from mailId:'
    }
  ])
    .then(answers => answers.from);
}

function getListOfMailIdByLabel(auth, labelId, maxResults = 500, nextPageToken) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      labelIds: labelId,
      maxResults: maxResults,
      pageToken: nextPageToken ? nextPageToken : undefined
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      if (response.data && response.data.nextPageToken) {
        messageIds = messageIds.concat(response.data.messages)
        spinner.text = "Reading page: " + ++pageCounter
        resolve(getListOfMailIdByLabel(auth, labelId, 500, response.data.nextPageToken))
      } else {
        messageIds = messageIds.concat(response.data.messages)
        resolve(messageIds)
      }

    });
  });
}

function getAllMails(auth, maxResults = 500, nextPageToken) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      maxResults: maxResults,
      pageToken: nextPageToken ? nextPageToken : undefined
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      if (response.data && response.data.nextPageToken) {
        messageIds = messageIds.concat(response.data.messages)
        spinner.text = "Reading page: " + ++pageCounter
        resolve(getAllMails(auth, 500, response.data.nextPageToken))
      } else {
        spinner.text = "All pages are read"
        resolve(messageIds)
      }

    });
  });
}

function getListOfMailIdByFromId(auth, mailId, maxResults = 500) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.list({
      auth: auth,
      userId: 'me',
      q: 'from:' + mailId,
      maxResults: maxResults
    }, function (err, response) {
      if (err) {
        console.log('The API returned an error: ' + err);
        reject(err);
      }
      resolve(response.data.messages);
    });
  });
}

async function fetchMailsByMailIds(auth, mailList) {
  let results = [];
  let promises = [];
  let counter = 0;
  let processed = 0;
  spinner.text = "Fetching each mail"
  for (index in mailList) {
    promises.push(getMail(auth, mailList[index].id));
    counter++;
    processed++;
    if (counter === 100) {
      console.log('llego a los 100')
      mails = await Promise.all(promises);
      results = results.concat(mails)

      promises = [];
      counter = 0;
      spinner.text = processed + " mails fetched"
      await sleep(3000)

    }
  };
  mails = await Promise.all(promises);
  results = results.concat(mails)
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getMail(auth, mailId) {
  return new Promise((resolve, reject) => {
    gmail.users.messages.get({
      userId: 'me',
      id: mailId,
      auth,
    }, (err, response) => {
      if (err) {
        reject(err);
      }
      resolve(response);
    })
  })
}

function fixBase64(binaryData) {
  const base64str = binaryData// base64 string from  thr response of server
  const binary = atob(base64str.replace(/\s/g, ''));// decode base64 string, remove space for IE compatibility
  const len = binary.length;         // get binary length
  const buffer = new ArrayBuffer(len);         // create ArrayBuffer with binary length
  const view = new Uint8Array(buffer);         // create 8-bit Array

  // save unicode of binary data into 8-bit Array
  for (let i = 0; i < len; i++) {
    view[i] = binary.charCodeAt(i);
  }

  return view;
}