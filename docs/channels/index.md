---
summary: "Messaging platforms OpenClaw can connect to"
read_when:
  - You want to choose a chat channel for OpenClaw
  - You need a quick overview of supported messaging platforms
title: "Chat Channels"
---

# Chat Channels

OpenClaw can talk to you on any chat app you already use. Each channel connects via the Gateway.
Text is supported everywhere; media and reactions vary by channel.

## Supported channels

- [BlueBubbles](/channels/bluebubbles) — **Recommended for iMessage**; uses the BlueBubbles macOS server REST API with full feature support (edit, unsend, effects, reactions, group management — edit currently broken on macOS 26 Tahoe).
- [Discord](/channels/discord) — Discord Bot API + Gateway; supports servers, channels, and DMs.
- [Feishu](/channels/feishu) — Feishu/Lark bot via WebSocket (plugin, installed separately).
- [Google Chat](/channels/googlechat) — Google Chat API app via HTTP webhook.
- [iMessage (legacy)](/channels/imessage) — Legacy macOS integration via imsg CLI (deprecated, use BlueBubbles for new setups).
- [IRC](/channels/irc) — Classic IRC servers; channels + DMs with pairing/allowlist controls.
- [LINE](/channels/line) — LINE Messaging API bot (plugin, installed separately).
- [Matrix](/channels/matrix) — Matrix protocol (plugin, installed separately).
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; channels, groups, DMs (plugin, installed separately).
- [Microsoft Teams](/channels/msteams) — Bot Framework; enterprise support (plugin, installed separately).
- [Nextcloud Talk](/channels/nextcloud-talk) — Self-hosted chat via Nextcloud Talk (plugin, installed separately).
- [Nostr](/channels/nostr) — Decentralized DMs via NIP-04 (plugin, installed separately).
- [Signal](/channels/signal) — signal-cli; privacy-focused.
- [Synology Chat](/channels/synology-chat) — Synology NAS Chat via outgoing+incoming webhooks (plugin, installed separately).
- [Slack](/channels/slack) — Bolt SDK; workspace apps.
- [Telegram](/channels/telegram) — Bot API via grammY; supports groups.
- [Tlon](/channels/tlon) — Urbit-based messenger (plugin, installed separately).
- [Twitch](/channels/twitch) — Twitch chat via IRC connection (plugin, installed separately).
- [WebChat](/web/webchat) — Gateway WebChat UI over WebSocket.
- [WhatsApp](/channels/whatsapp) — Most popular; uses Baileys and requires QR pairing.
- [Zalo](/channels/zalo) — Zalo Bot API; Vietnam's popular messenger (plugin, installed separately).
- [Zalo Personal](/channels/zalouser) — Zalo personal account via QR login (plugin, installed separately).

## Connection architecture

Channels use different transport modes to communicate with their upstream services. Understanding this helps with firewall rules, reverse proxy setup, and debugging.

| Transport              | How it works                                                                                                | Inbound infra needed         | Channels                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| **Outbound WebSocket** | Gateway opens a persistent WebSocket to the service. All messages flow over this single connection.         | None — outbound only.        | Discord, Mattermost, Feishu, Slack, Matrix, IRC, Twitch, Tlon, Nostr, WebChat |
| **Long polling**       | Gateway repeatedly polls the service API for new messages.                                                  | None — outbound only.        | Telegram (default), Signal                                                    |
| **Inbound webhook**    | Service pushes messages to a URL you expose. Requires a public endpoint (reverse proxy, ALB, tunnel, etc.). | Yes — public HTTPS endpoint. | Telegram (optional), Google Chat, Microsoft Teams, LINE, Synology Chat, Zalo  |
| **Local API / CLI**    | Gateway talks to a local process or REST API on the same machine.                                           | None — localhost only.       | BlueBubbles, iMessage (legacy), Signal (signal-cli), Nextcloud Talk           |
| **Browser session**    | Gateway maintains a headless or QR-paired browser session.                                                  | None — outbound only.        | WhatsApp (Baileys), Zalo Personal                                             |

<Note>
Some channels support multiple transports. For example, Telegram defaults to long polling but can switch to webhook mode by setting `channels.telegram.webhookUrl`. Check each channel's docs for options.
</Note>

### What this means in practice

- **Outbound-only channels** (Discord, Slack, IRC, etc.) work behind NATs and firewalls with no extra infra. The gateway initiates all connections.
- **Webhook channels** (Telegram webhook mode, Google Chat, Microsoft Teams) need a publicly reachable HTTPS endpoint — typically a reverse proxy (nginx, Caddy) or cloud load balancer (ALB, Cloud Run) forwarding to the gateway.
- **Local channels** (BlueBubbles, signal-cli) need the companion service running on the same host or reachable on the local network.

## Notes

- Channels can run simultaneously; configure multiple and OpenClaw will route per chat.
- Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and
  stores more state on disk.
- Group behavior varies by channel; see [Groups](/channels/groups).
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Troubleshooting: [Channel troubleshooting](/channels/troubleshooting).
- Model providers are documented separately; see [Model Providers](/providers/models).
