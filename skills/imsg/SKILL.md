---
name: imsg
description: iMessage/SMS CLI for listing chats, history, watch, and sending.
homepage: https://imsg.to
metadata:
  {
    "openclaw":
      {
        "emoji": "📨",
        "os": ["darwin"],
        "requires": { "bins": ["imsg"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/imsg",
              "bins": ["imsg"],
              "label": "Install imsg (brew)",
            },
          ],
      },
  }
---

# imsg Actions

## Overview

Use `imsg` to read and send Messages.app iMessage/SMS on macOS.

Requirements: Messages.app signed in, Full Disk Access for your terminal, and Automation permission to control Messages.app for sending.

## Inputs to collect

- Recipient handle (phone/email) for `send`
- `chatId` for history/watch (from `imsg chats --limit 10 --json`)
- `text` and optional `file` path for sends

## Actions

### List chats

```bash
imsg chats --limit 10 --json
```

### Fetch chat history

```bash
imsg history --chat-id 1 --limit 20 --attachments --json
```

### Watch a chat

```bash
imsg watch --chat-id 1 --attachments
```

### Send a message

```bash
imsg send --to "+14155551212" --text "hi" --file /path/pic.jpg
```

## Notes

- `--service imessage|sms|auto` controls delivery.
- Confirm recipient + message before sending.

## Ideas to try

- Use `imsg chats --limit 10 --json` to discover chat ids.
- Watch a high-signal chat to stream incoming messages.
