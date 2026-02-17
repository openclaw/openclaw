---
title: "SimpleX Chat"
summary: "Zero-metadata encrypted DMs via SimpleX Chat CLI"
read_when:
  - Setting up SimpleX Chat as a channel
  - Configuring privacy-first messaging
---

# SimpleX Chat

SimpleX Chat provides **zero-metadata encrypted messaging** with no user identifiers.
Unlike Signal (phone number) or Telegram (username), SimpleX has no account identity at all.

This makes it ideal for high-security environments where metadata protection matters.

## Quick start

1. Install the SimpleX CLI and create a profile:

```bash
# Download
curl -L https://github.com/simplex-chat/simplex-chat/releases/latest/download/simplex-chat-ubuntu-22_04-x86-64 -o /usr/local/bin/simplex-chat
chmod +x /usr/local/bin/simplex-chat

# Create profile (first run)
simplex-chat
# /quit after setup
```

2. Start the CLI as a WebSocket server:

```bash
simplex-chat -p 5225
```

3. Install and enable the plugin:

```bash
openclaw plugins install @openclaw/simplex
```

4. Configure:

```json
{
  "channels": {
    "simplex": {
      "enabled": true,
      "wsPort": 5225,
      "dmPolicy": "pairing"
    }
  }
}
```

5. Restart the gateway:

```bash
openclaw gateway restart
```

## Pairing

SimpleX contacts are established by sharing one-time invitation links.

To connect your SimpleX app to the bot:

1. Generate a contact link from the bot: the plugin auto-creates one on startup
2. Scan or open the link in your SimpleX app
3. The bot accepts the request; pairing approval is handled at the OpenClaw level

## Security

- **Bind to localhost only** — the WebSocket server has no authentication
- Protect `~/.simplex/` — it contains your encryption keys
- Use `dmPolicy: "pairing"` (default) to require approval for new contacts
- SimpleX provides forward secrecy and break-in recovery via double ratchet
- No phone numbers, no usernames, no metadata correlation

## Limitations (MVP)

- DMs only (no group chats yet)
- Text only (no media/file attachments yet)
- No message editing or reactions
- Single account per gateway

These will be addressed in future releases.
