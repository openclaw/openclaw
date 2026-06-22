---
summary: "Adds the Telegram channel surface for sending and receiving OpenClaw messages."
read_when:
  - You are installing, configuring, or auditing the telegram plugin
title: "Telegram plugin"
---

# Telegram plugin

Adds the Telegram channel surface for sending and receiving OpenClaw messages.

## Distribution

- Package: `@openclaw/telegram`
- Install route: included in OpenClaw

## Surface

channels: telegram

## Runtime API

Plugins that need raw Telegram updates can import
`registerTelegramIngressExtension` from `@openclaw/telegram/runtime-api.js`.
The registered `handleRawUpdate` callback runs inside the bundled Telegram bot
before normal routing. Returning `"handled"` stops the regular Telegram
handlers; returning `"continue"` or nothing lets the update fall through.

The bundled Telegram plugin still owns polling and webhooks. Use this hook when
another plugin needs to observe or handle an update type that Telegram already
delivers to the configured bot, without starting a second poller.

## Related docs

- [telegram](/channels/telegram)
