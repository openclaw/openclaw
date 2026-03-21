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

| Transport                     | How it works                                                                                                              | Inbound infra needed                       | Channels                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebSocket + HTTPS API**     | Persistent WebSocket for inbound events; outbound sends use the service's HTTPS API. Both egress paths required.          | None — outbound only.                      | Discord, Slack (Socket Mode), Mattermost, Feishu (default)                                                                                      |
| **WebSocket (bidirectional)** | All traffic flows over a single persistent WebSocket connection (both inbound events and outbound sends).                 | None — outbound only.                      | Twitch (IRC protocol over WebSocket), Nostr                                                                                                     |
| **Outbound TCP/TLS**          | Gateway opens a persistent TCP connection to the server (classic IRC protocol).                                           | None — outbound only.                      | IRC                                                                                                                                             |
| **Outbound HTTP/SSE**         | Gateway connects over HTTP; inbound events arrive via a long-lived SSE stream with automatic reconnects.                  | None — outbound only.                      | Tlon (Urbit ship API)                                                                                                                           |
| **Long polling**              | Gateway repeatedly polls the service API for new messages.                                                                | None — outbound only.                      | Telegram (default), Zalo (default)                                                                                                              |
| **Inbound webhook**           | Service pushes messages to a URL you expose. Gateway must be reachable by the sending service.                            | Depends — public or local network.         | Telegram (optional), Slack (HTTP Events), Feishu (optional), Google Chat, Microsoft Teams, LINE, Nextcloud Talk, Synology Chat, Zalo (optional) |
| **Local REST + webhook**      | Gateway talks to a companion app via REST; incoming messages arrive via webhook. Can be co-located or split across hosts. | Local or remote network.                   | BlueBubbles                                                                                                                                     |
| **Local CLI / JSON-RPC**      | Gateway communicates with a local process via JSON-RPC + SSE or stdio. Remote operation possible via SSH or HTTP.         | None by default (localhost, SSH, or HTTP). | Signal (signal-cli), iMessage (legacy, imsg)                                                                                                    |
| **Linked session**            | Gateway maintains a linked device session (like WhatsApp Web). QR pairing required.                                       | None — outbound only.                      | WhatsApp (Baileys), Zalo Personal                                                                                                               |
| **Gateway WebSocket**         | Client (browser or native app) connects **to** the gateway's own WebSocket endpoint.                                      | Gateway must be reachable by client.       | WebChat                                                                                                                                         |
| **Matrix SDK**                | Gateway uses the Matrix client SDK to sync with a homeserver (outbound long-polling via `/sync`).                         | None — outbound only.                      | Matrix                                                                                                                                          |

<Note>
Some channels support multiple transports. For example, Telegram defaults to long polling but can switch to webhook mode by setting `channels.telegram.webhookUrl` and `channels.telegram.webhookSecret` (both required). Slack defaults to Socket Mode (WebSocket) but also supports HTTP Events API. Mattermost uses WebSocket for messages but its optional native slash commands require inbound HTTP callbacks. Discord voice features additionally require a voice WebSocket and UDP egress. Signal's remote daemon mode uses a long-lived SSE stream for inbound events. Check each channel's docs for options.
</Note>

### What this means in practice

- **Outbound-only channels** work behind NATs and firewalls with no extra infra. Channels using WebSocket + HTTPS API (Discord, Slack, Mattermost, Feishu) require both WebSocket and HTTPS egress. Bidirectional WebSocket channels (Twitch, Nostr) only need WebSocket egress.
- **Webhook channels** need the gateway to be reachable by the sending service. Cloud-hosted services (Google Chat, Microsoft Teams, Telegram webhook mode, LINE, Zalo webhook mode) require a public HTTPS endpoint. Self-hosted services (Nextcloud Talk, Synology Chat) only need local network reachability.
- **Local channels** (BlueBubbles, Signal, iMessage) often run on the same host but support remote setups. BlueBubbles can split across hosts; Signal supports external HTTP daemons (with SSE for inbound events); iMessage supports remote Macs over SSH.
- **WebChat** requires the gateway to be reachable by the browser or native app — either on localhost, via Tailscale, or through an SSH tunnel.

## Notes

- Channels can run simultaneously; configure multiple and OpenClaw will route per chat.
- Fastest setup is usually **Telegram** (simple bot token). WhatsApp requires QR pairing and
  stores more state on disk.
- Group behavior varies by channel; see [Groups](/channels/groups).
- DM pairing and allowlists are enforced for safety; see [Security](/gateway/security).
- Troubleshooting: [Channel troubleshooting](/channels/troubleshooting).
- Model providers are documented separately; see [Model Providers](/providers/models).
