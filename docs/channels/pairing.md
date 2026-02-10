---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Pairing overview: approve who can DM you + which nodes can join"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up DM access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pairing a new iOS/Android node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Reviewing OpenClaw security posture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Pairing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
“Pairing” is OpenClaw’s explicit **owner approval** step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
It is used in two places:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **DM pairing** (who is allowed to talk to the bot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Node pairing** (which devices/nodes are allowed to join the gateway network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security context: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) DM pairing (inbound chat access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a channel is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default DM policies are documented in: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing codes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- 8 characters, uppercase, no ambiguous chars (`0O1I`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pending DM pairing requests are capped at **3 per channel** by default; additional requests are ignored until one expires or is approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Approve a sender（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing approve telegram <CODE>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supported channels: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Where the state lives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stored under `~/.openclaw/credentials/`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pending requests: `<channel>-pairing.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approved allowlist store: `<channel>-allowFrom.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat these as sensitive (they gate access to your assistant).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Node device pairing (iOS/Android/macOS/headless nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes connect to the Gateway as **devices** with `role: node`. The Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
creates a device pairing request that must be approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pair via Telegram (recommended for iOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you use the `device-pair` plugin, you can do first-time device pairing entirely from Telegram:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. In Telegram, message your bot: `/pair`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The bot replies with two messages: an instruction message and a separate **setup code** message (easy to copy/paste in Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. On your phone, open the OpenClaw iOS app → Settings → Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Paste the setup code and connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Back in Telegram: `/pair approve`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The setup code is a base64-encoded JSON payload that contains:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `url`: the Gateway WebSocket URL (`ws://...` or `wss://...`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `token`: a short-lived pairing token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Treat the setup code like a password while it is valid.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Approve a node device（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices reject <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Node pairing state storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Stored under `~/.openclaw/devices/`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pending.json` (short-lived; pending requests expire)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `paired.json` (paired devices + tokens)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The legacy `node.pair.*` API (CLI: `openclaw nodes pending/approve`) is a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  separate gateway-owned pairing store. WS nodes still require device pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security model + prompt injection: [Security](/gateway/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updating safely (run doctor): [Updating](/install/updating)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel configs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram: [Telegram](/channels/telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - WhatsApp: [WhatsApp](/channels/whatsapp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Signal: [Signal](/channels/signal)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - iMessage (legacy): [iMessage](/channels/imessage)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord: [Discord](/channels/discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Slack: [Slack](/channels/slack)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
