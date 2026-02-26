https://serper.dev/

##nomal

const axios = require('axios');
let data = JSON.stringify({
"q": "apple inc"
});

let config = {
method: 'post',
maxBodyLength: Infinity,
url: 'https://google.serper.dev/search',
headers: {
'X-API-KEY': 'xxx',
'Content-Type': 'application/json'
},
data : data
};

async function makeRequest() {
try {
const response = await axios.request(config);
console.log(JSON.stringify(response.data));
}
catch (error) {
console.log(error);
}
}

makeRequest();

##scholar

const axios = require('axios');
let data = JSON.stringify({
"q": "apple inc"
});

let config = {
method: 'post',
maxBodyLength: Infinity,
url: 'https://google.serper.dev/scholar',
headers: {
'X-API-KEY': 'xxx',
'Content-Type': 'application/json'
},
data : data
};

async function makeRequest() {
try {
const response = await axios.request(config);
console.log(JSON.stringify(response.data));
}
catch (error) {
console.log(error);
}
}

makeRequest();

cccc

const axios = require('axios');
let data = JSON.stringify({
"url": "https://arxiv.org/pdf/2310.16427"
});

let config = {
method: 'post',
maxBodyLength: Infinity,
url: 'https://scrape.serper.dev',
headers: {
'X-API-KEY': 'xxx',
'Content-Type': 'application/json'
},
data : data
};

async function makeRequest() {
try {
const response = await axios.request(config);
console.log(JSON.stringify(response.data));
}
catch (error) {
console.log(error);
}
}

makeRequest();
