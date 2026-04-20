function mrkdwn(text) {
  return { type: 'mrkdwn', text };
}

function renderSection(s) {
  if (s.fields) {
    return { type: 'section', fields: s.fields.map(f => mrkdwn(f)) };
  }
  return { type: 'section', text: mrkdwn(s.text) };
}

function renderButton(a) {
  const btn = {
    type: 'button',
    text: { type: 'plain_text', text: a.text },
  };
  if (a.url) btn.url = a.url;
  if (a.actionId) btn.action_id = a.actionId;
  else btn.action_id = `action_${a.text.toLowerCase().replace(/\s+/g, '_')}`;
  if (a.style) btn.style = a.style;
  if (a.value) btn.value = a.value;
  return btn;
}

function renderBlocks(msg) {
  const blocks = [];

  if (msg.sections) {
    msg.sections.forEach(s => blocks.push(renderSection(s)));
  }

  if (msg.divider) {
    blocks.push({ type: 'divider' });
  }

  if (msg.actions && msg.actions.length) {
    blocks.push({ type: 'actions', elements: msg.actions.map(renderButton) });
  }

  if (msg.context && msg.context.length) {
    blocks.push({ type: 'context', elements: msg.context.map(c => mrkdwn(c)) });
  }

  return blocks;
}

module.exports = { renderBlocks };
