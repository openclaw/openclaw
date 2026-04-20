const { renderBlocks } = require('./renderer');
const { postMessage } = require('./slack');

async function renderAndSend(agentMessage, opts = {}) {
  const blocks = renderBlocks(agentMessage);
  const channel = opts.channel || process.env.SLACK_CHANNEL;
  return postMessage({ channel, text: agentMessage.text || '', blocks });
}

module.exports = { renderAndSend, renderBlocks };
