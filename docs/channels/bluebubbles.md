---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "iMessage via BlueBubbles macOS server (REST send/receive, typing, reactions, pairing, advanced actions)."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up BlueBubbles channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Troubleshooting webhook pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Configuring iMessage on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "BlueBubbles"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# BlueBubbles (macOS REST)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Status: bundled plugin that talks to the BlueBubbles macOS server over HTTP. **Recommended for iMessage integration** due to its richer API and easier setup compared to the legacy imsg channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs on macOS via the BlueBubbles helper app ([bluebubbles.app](https://bluebubbles.app)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Recommended/tested: macOS Sequoia (15). macOS Tahoe (26) works; edit is currently broken on Tahoe, and group icon updates may report success but not sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw talks to it through its REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Incoming messages arrive via webhooks; outgoing replies, typing indicators, read receipts, and tapbacks are REST calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attachments and stickers are ingested as inbound media (and surfaced to the agent when possible).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing/allowlist works the same way as other channels (`/channels/pairing` etc) with `channels.bluebubbles.allowFrom` + pairing codes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reactions are surfaced as system events just like Slack/Telegram so agents can "mention" them before replying.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Advanced features: edit, unsend, reply threading, message effects, group management.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install the BlueBubbles server on your Mac (follow the instructions at [bluebubbles.app/install](https://bluebubbles.app/install)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. In the BlueBubbles config, enable the web API and set a password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Run `openclaw onboard` and select BlueBubbles, or configure manually:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       bluebubbles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         serverUrl: "http://192.168.1.100:1234",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         password: "example-password",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
         webhookPath: "/bluebubbles-webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
       },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Point BlueBubbles webhooks to your gateway (example: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Start the gateway; it will register the webhook handler and start pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Keeping Messages.app alive (VM / headless setups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some macOS VM / always-on setups can end up with Messages.app going “idle” (incoming events stop until the app is opened/foregrounded). A simple workaround is to **poke Messages every 5 minutes** using an AppleScript + LaunchAgent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Save the AppleScript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Save this as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Scripts/poke-messages.scpt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example script (non-interactive; does not steal focus):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```applescript（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tell application "Messages"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    if not running then（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      launch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    end if（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    -- Touch the scripting interface to keep the process responsive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    set _chatCount to (count of chats)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  end tell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -- Ignore transient failures (first-run prompts, locked session, etc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
end try（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Install a LaunchAgent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Save this as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Library/LaunchAgents/com.user.poke-messages.plist`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```xml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<?xml version="1.0" encoding="UTF-8"?>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<plist version="1.0">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>Label</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>com.user.poke-messages</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>ProgramArguments</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <string>/bin/bash</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <string>-lc</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </array>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>RunAtLoad</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>StartInterval</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <integer>300</integer>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>StandardOutPath</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>/tmp/poke-messages.log</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>StandardErrorPath</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <string>/tmp/poke-messages.err</string>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</plist>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This runs **every 300 seconds** and **on login**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The first run may trigger macOS **Automation** prompts (`osascript` → Messages). Approve them in the same user session that runs the LaunchAgent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BlueBubbles is available in the interactive setup wizard:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The wizard prompts for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Server URL** (required): BlueBubbles server address (e.g., `http://192.168.1.100:1234`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Password** (required): API password from BlueBubbles Server settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Webhook path** (optional): Defaults to `/bluebubbles-webhook`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **DM policy**: pairing, allowlist, open, or disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Allow list**: Phone numbers, emails, or chat targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can also add BlueBubbles via CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control (DMs + groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DMs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default: `channels.bluebubbles.dmPolicy = "pairing"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unknown senders receive a pairing code; messages are ignored until approved (codes expire after 1 hour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Approve via:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing list bluebubbles`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `openclaw pairing approve bluebubbles <CODE>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Groups:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (default: `allowlist`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.groupAllowFrom` controls who can trigger in groups when `allowlist` is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Mention gating (groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BlueBubbles supports mention gating for group chats, matching iMessage/WhatsApp behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) to detect mentions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `requireMention` is enabled for a group, the agent only responds when mentioned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control commands from authorized senders bypass mention gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-group configuration:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bluebubbles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupPolicy: "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groupAllowFrom: ["+15555550123"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "*": { requireMention: true }, // default for all groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "iMessage;-;chat123": { requireMention: false }, // override for specific group（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Command gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control commands (e.g., `/config`, `/model`) require authorization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `allowFrom` and `groupAllowFrom` to determine command authorization.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Authorized senders can run control commands even without mentioning in groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Typing + read receipts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Typing indicators**: Sent automatically before and during response generation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Read receipts**: Controlled by `channels.bluebubbles.sendReadReceipts` (default: `true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Typing indicators**: OpenClaw sends typing start events; BlueBubbles clears typing automatically on send or timeout (manual stop via DELETE is unreliable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bluebubbles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      sendReadReceipts: false, // disable read receipts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BlueBubbles supports advanced message actions when enabled in config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bluebubbles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      actions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reactions: true, // tapbacks (default: true)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        unsend: true, // unsend messages (macOS 13+)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        reply: true, // reply threading by message GUID（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sendWithEffect: true, // message effects (slam, loud, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        renameGroup: true, // rename group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        addParticipant: true, // add participants to groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        removeParticipant: true, // remove participants from groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        leaveGroup: true, // leave group chats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        sendAttachment: true, // send attachments/media（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **react**: Add/remove tapback reactions (`messageId`, `emoji`, `remove`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **edit**: Edit a sent message (`messageId`, `text`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **unsend**: Unsend a message (`messageId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **reply**: Reply to a specific message (`messageId`, `text`, `to`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **sendWithEffect**: Send with iMessage effect (`text`, `to`, `effectId`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **renameGroup**: Rename a group chat (`chatGuid`, `displayName`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **setGroupIcon**: Set a group chat's icon/photo (`chatGuid`, `media`) — flaky on macOS 26 Tahoe (API may return success but the icon does not sync).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **addParticipant**: Add someone to a group (`chatGuid`, `address`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **removeParticipant**: Remove someone from a group (`chatGuid`, `address`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **leaveGroup**: Leave a group chat (`chatGuid`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **sendAttachment**: Send media/files (`to`, `buffer`, `filename`, `asVoice`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Voice memos: set `asVoice: true` with **MP3** or **CAF** audio to send as an iMessage voice message. BlueBubbles converts MP3 → CAF when sending voice memos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Message IDs (short vs full)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw may surface _short_ message IDs (e.g., `1`, `2`) to save tokens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MessageSid` / `ReplyToId` can be short IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `MessageSidFull` / `ReplyToIdFull` contain the provider full IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Short IDs are in-memory; they can expire on restart or cache eviction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Actions accept short or full `messageId`, but short IDs will error if no longer available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use full IDs for durable automations and storage:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Templates: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Context: `MessageSidFull` / `ReplyToIdFull` in inbound payloads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Configuration](/gateway/configuration) for template variables.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Block streaming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Control whether responses are sent as a single message or streamed in blocks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bluebubbles: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      blockStreaming: true, // enable block streaming (off by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Media + limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Inbound attachments are downloaded and stored in the media cache.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media cap via `channels.bluebubbles.mediaMaxMb` (default: 8 MB).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Outbound text is chunked to `channels.bluebubbles.textChunkLimit` (default: 4000 chars).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full configuration: [Configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Provider options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.enabled`: Enable/disable the channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.serverUrl`: BlueBubbles REST API base URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.password`: API password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.webhookPath`: Webhook endpoint path (default: `/bluebubbles-webhook`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (default: `pairing`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.allowFrom`: DM allowlist (handles, emails, E.164 numbers, `chat_id:*`, `chat_guid:*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (default: `allowlist`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.groupAllowFrom`: Group sender allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.groups`: Per-group config (`requireMention`, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.sendReadReceipts`: Send read receipts (default: `true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.blockStreaming`: Enable block streaming (default: `false`; required for streaming replies).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.textChunkLimit`: Outbound chunk size in chars (default: 4000).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.chunkMode`: `length` (default) splits only when exceeding `textChunkLimit`; `newline` splits on blank lines (paragraph boundaries) before length chunking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.mediaMaxMb`: Inbound media cap in MB (default: 8).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.historyLimit`: Max group messages for context (0 disables).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.dmHistoryLimit`: DM history limit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.actions`: Enable/disable specific actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.bluebubbles.accounts`: Multi-account configuration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related global options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `messages.responsePrefix`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Addressing / delivery targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer `chat_guid` for stable routing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_guid:iMessage;-;+15555550123` (preferred for groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_id:123`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `chat_identifier:...`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Direct handles: `+15555550123`, `user@example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If a direct handle does not have an existing DM chat, OpenClaw will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Webhook requests are authenticated by comparing `guid`/`password` query params or headers against `channels.bluebubbles.password`. Requests from `localhost` are also accepted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep the API password and webhook endpoint secret (treat them like credentials).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Localhost trust means a same-host reverse proxy can unintentionally bypass the password. If you proxy the gateway, require auth at the proxy and configure `gateway.trustedProxies`. See [Gateway security](/gateway/security#reverse-proxy-configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable HTTPS + firewall rules on the BlueBubbles server if exposing it outside your LAN.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If typing/read events stop working, check the BlueBubbles webhook logs and verify the gateway path matches `channels.bluebubbles.webhookPath`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing codes expire after one hour; use `openclaw pairing list bluebubbles` and `openclaw pairing approve bluebubbles <code>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reactions require the BlueBubbles private API (`POST /api/v1/message/react`); ensure the server version exposes it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group icon updates can be flaky on macOS 26 (Tahoe): the API may return success but the new icon does not sync.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenClaw auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For status/health info: `openclaw status --all` or `openclaw status --deep`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For general channel workflow reference, see [Channels](/channels) and the [Plugins](/tools/plugin) guide.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
