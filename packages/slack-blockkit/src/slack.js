require('dotenv').config();
const { WebClient } = require('@slack/web-api');

let client;
function getClient() {
  if (!client) client = new WebClient(process.env.SLACK_BOT_TOKEN);
  return client;
}

async function postMessage({ channel, text, blocks }) {
  if (!channel) {
    throw new Error('Slack channel is required — set opts.channel or SLACK_CHANNEL env var');
  }
  try {
    return await getClient().chat.postMessage({ channel, text, blocks });
  } catch (err) {
    const code = err.data?.error || err.code || 'unknown';
    throw new Error(`Slack API error (${code}): ${err.message}`);
  }
}

module.exports = { postMessage };
