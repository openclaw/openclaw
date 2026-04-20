# @openclaw/slack-blockkit

Slack Block Kit renderer for OpenClaw agent messages — converts structured message objects into Slack blocks, buttons, sections, dividers, and context elements.

## Usage

```js
const { renderAndSend, renderBlocks } = require('@openclaw/slack-blockkit');

// Render and send in one call
await renderAndSend({
  text: 'Fallback text',
  sections: [{ text: '*Hello* from OpenClaw' }],
  actions: [{ text: 'Click me', url: 'https://example.com' }],
}, { channel: '#general' });

// Or just render blocks (pure function)
const blocks = renderBlocks(message);
```

## Configuration

| Env var | Description |
|---------|-------------|
| `SLACK_BOT_TOKEN` | Slack Bot OAuth token |
| `SLACK_CHANNEL` | Default channel (fallback if not passed in opts) |

## Error handling

- Throws if `channel` is not provided (neither in opts nor env)
- Wraps Slack API errors with the error code for easier debugging
- Rate limit errors from Slack are surfaced with the original error code
