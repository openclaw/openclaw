---
summary: "TypeX channel setup and configuration"
read_when:
  - You want to connect OpenClaw to TypeX
  - You are configuring TypeX QR login
title: "TypeX"
---

# TypeX

TypeX is available as a plugin channel.

## Plugin required

Install the plugin:

```bash
openclaw plugins install @openclaw/typex
```

Local checkout:

```bash
openclaw plugins install ./extensions/typex
```

## Quick setup

1. Run channel setup:

```bash
openclaw channels add
```

2. Select **TypeX**.
3. Scan the QR code shown in the terminal.
4. After login succeeds, OpenClaw saves your `token` under `channels.typex.accounts.<userId>`.

## Minimal config

```json5
{
  channels: {
    typex: {
      enabled: true,
      defaultAccount: "<user_id>",
      accounts: {
        "<user_id>": {
          token: "sessionid=...",
        },
      },
    },
  },
}
```

## Capabilities

- Direct messages: supported
- Media send: supported
- Reactions: not supported
- Threads: not supported
- Polls: not supported

## Notes

- Inbound messages are polled from TypeX API.
- Message offset (`pos`) is stored in `channels.typex.accounts.<accountId>.pos`.
- Default target hint is `chat_id`.
