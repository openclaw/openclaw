# Feishu Card Interaction Update

## Overview

The Feishu plugin supports interactive card updates. When users click buttons on cards, the card can immediately update to show a "processing" state while the agent works on the request.

## How It Works

1. **User clicks button** on an interactive card
2. **Card immediately updates** to show "Processing..." with a yellow header
3. **Agent receives the request** with an `updateId`
4. **Agent processes** and calls `card.update` with results
5. **Card updates** with the final result

## Card Button Payload

To create an updatable card button, use the `update` interaction kind:

```json
{
  "tag": "button",
  "text": { "tag": "plain_text", "content": "Generate Report" },
  "type": "primary",
  "value": {
    "oc": "ocf1",
    "k": "update",
    "a": "feishu.card.update.generate",
    "m": {
      "messageId": "msg_xxx",
      "prompt": "Generate a sales report",
      "command": "/report"
    },
    "c": {
      "u": "user_open_id",
      "h": "chat_id",
      "t": "group",
      "e": 1700000060000
    }
  }
}
```

### Metadata Fields (`m`)

- `messageId` (required): The ID of the message containing this card (for updating)
- `prompt` (optional): Description shown in processing state
- `command` (optional): Command to execute (shown if prompt not provided)

## Agent Usage

When an `update` card action is triggered, the agent receives a message like:

```
[Card Update Request]
updateId: cu_1700000000000_abc123
prompt: Generate a sales report
command: /report
action: feishu.card.update.generate
```

### Updating the Card

Use the `card.update` action:

```json
{
  "action": "card.update",
  "updateId": "cu_1700000000000_abc123",
  "card": {
    "schema": "2.0",
    "header": {
      "title": { "content": "Report Complete", "tag": "plain_text" },
      "template": "green"
    },
    "body": {
      "elements": [{ "tag": "markdown", "content": "Your report is ready!" }]
    }
  }
}
```

Or with text:

```json
{
  "action": "card.update",
  "updateId": "cu_1700000000000_abc123",
  "text": "Your report is ready! Total sales: $10,000"
}
```

## Timeout

Card updates are kept for 15 minutes. After that, the update ID expires and cannot be used.
