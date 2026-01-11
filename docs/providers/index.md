---
summary: "Messaging platforms Clawdbot can connect to"
read_when:
  - You want to choose a chat provider for Clawdbot
  - You need a quick overview of supported messaging platforms
---
# Chat Providers

Clawdbot can talk to you on any chat app you already use. Each provider connects via the Gateway.
Text is supported everywhere; media and reactions vary by provider.

## Supported providers

- [WhatsApp](/providers/whatsapp) — Most popular; uses Baileys and requires QR pairing.
- [Telegram](/providers/telegram) — Bot API via grammY; supports groups.
- [Discord](/providers/discord) — Discord Bot API + Gateway; supports servers, channels, and DMs.
- [Slack](/providers/slack) — Bolt SDK; workspace apps.
- [Signal](/providers/signal) — signal-cli; privacy-focused.
- [iMessage](/providers/imessage) — macOS only; native integration.
- [Microsoft Teams](/providers/msteams) — Bot Framework; enterprise support.
- [WebChat](/web/webchat) — Gateway WebChat UI over WebSocket.

## Notes

- Providers can run simultaneously; configure multiple and Clawdbot will route per chat.
- Group behavior varies by provider; see [Groups](/concepts/groups).
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Telegram internals: [grammY notes](/providers/grammy).
- Troubleshooting: [Provider troubleshooting](/providers/troubleshooting).
- Model providers are documented separately; see [Model Providers](/providers/models).
