---
summary: "Synology Chat support status, capabilities, and configuration"
title: "Synology Chat"
---

# Synology Chat (plugin)

Status: supported via plugin (webhook bot).

Synology Chat is the built-in chat application for Synology DiskStation Manager (DSM). This plugin allows you to chat with your OpenClaw AI assistant through Synology Chat.

## Quick setup

### Prerequisites

- Synology DSM 6.x or later with Chat installed
- Network access from your Synology NAS to the OpenClaw server

### Step 1: Install the plugin

Ensure the Synology Chat plugin is installed in your OpenClaw instance.

### Step 2: Create an incoming webhook in Synology Chat

1. Open Synology Chat on your DSM
2. Go to **Settings** > **Integrations** > **Incoming Webhooks**
3. Click **Create**
4. Give it a name (e.g., "OpenClaw Bot")
5. Select the channel or user to send messages as
6. Copy the generated **Webhook URL** and extract the token from it

The URL format is typically:
```
https://{nas-host}/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token="{token}"
```

You only need the `{token}` part for configuration.

### Step 3: Create an outgoing webhook in Synology Chat

1. Go to **Settings** > **Integrations** > **Outgoing Webhooks**
2. Click **Create**
3. Configure:
   - **Name**: OpenClaw Webhook
   - **URL**: `http://{openclaw-host}:8789/synology-chat-webhook`
   - **Format**: JSON or Form Data
4. Copy the token for verification

### Step 4: Configure OpenClaw

Add the following to your OpenClaw configuration:

```yaml
channels:
  synology-chat:
    enabled: true
    incomingUrl: "https://nas.example.com:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=\"your-token\""
    token: "your-outgoing-webhook-token"  # For webhook verification
    webhookPath: "/webhook/synology"
    dmPolicy: "open"  # pairing | allowlist | open | disabled
    allowInsecureSsl: true  # Only for self-signed certificates
```

Or using separate `baseUrl` and `token`:

```yaml
channels:
  synology-chat:
    enabled: true
    baseUrl: "https://nas.example.com:5001"
    token: "your-incoming-webhook-token"
    webhookPort: 8789
    webhookPublicUrl: "https://openclaw.example.com/synology-chat-webhook"  # Optional, if behind proxy
    dmPolicy: "pairing"  # pairing | allowlist | open | disabled
```

Or use environment variables:

```bash
SYNOLOGY_CHAT_TOKEN=your-incoming-webhook-token
```

### Step 5: Restart OpenClaw

```bash
openclaw restart
```

## Capabilities

| Feature         | Status          | Notes                         |
| --------------- | --------------- | ----------------------------- |
| Direct messages | Supported       | Webhook-based                 |
| Groups          | Not supported   | Synology Chat API limitation  |
| Threads         | Not supported   | Synology Chat API limitation  |
| Media           | Not supported   | Synology Chat API limitation  |
| Reactions       | Not supported   | Synology Chat API limitation  |
| Streaming       | Blocked         | Webhook doesn't support it    |

## Configuration reference

### Account configuration

| Option                  | Type     | Default                  | Description                                      |
| ----------------------- | -------- | ------------------------ | ------------------------------------------------ |
| `enabled`               | boolean  | `true`                   | Enable/disable this channel                      |
| `name`                  | string   | account id               | Display name for this account                    |
| `baseUrl`               | string   |                          | Synology DSM URL (e.g., `https://nas.example.com:5001`) |
| `incomingUrl`           | string   |                          | Full incoming webhook URL (alternative to baseUrl + token) |
| `token`                 | string   |                          | Incoming webhook token                           |
| `tokenFile`             | string   |                          | Path to file containing token                    |
| `allowInsecureSsl`      | boolean  | `false`                  | Allow self-signed SSL certificates               |
| `dmPolicy`              | string   | `pairing`                | DM access policy (see below)                     |
| `allowedUserIds`        | string[] | `[]`                     | User IDs allowed to DM (for allowlist policy)    |
| `webhookPort`           | number   | `8789`                   | Port for webhook server                          |
| `webhookHost`           | string   | `0.0.0.0`                | Host for webhook server                          |
| `webhookPath`           | string   | `/synology-chat-webhook` | Webhook endpoint path                            |
| `webhookPublicUrl`      | string   |                          | Public URL if behind reverse proxy               |
| `historyLimit`          | number   | `50`                     | Max messages to keep in history                  |
| `dmHistoryLimit`        | number   | `20`                     | Max DM turns to keep in history                  |
| `textChunkLimit`        | number   | `4000`                   | Max characters per message                       |
| `blockStreaming`        | boolean  | `true`                   | Block streaming responses                        |

### DM Policy options

| Policy     | Description                                         |
| ---------- | --------------------------------------------------- |
| `pairing`  | Users must confirm pairing before chatting (default)|
| `allowlist`| Only users in `allowFrom` can message               |
| `open`     | Anyone can message (not recommended)                |
| `disabled` | No DMs allowed                                      |

### Multi-account configuration

For multiple Synology NAS instances:

```yaml
channels:
  synology-chat:
    accounts:
      home:
        name: "Home NAS"
        baseUrl: "https://home-nas.example.com:5001"
        token: "home-token"
        webhookPort: 8789
      office:
        name: "Office NAS"
        baseUrl: "https://office-nas.example.com:5001"
        token: "office-token"
        webhookPort: 8790
```

## Using with reverse proxy

If OpenClaw is behind a reverse proxy like Nginx or Caddy:

1. Configure `webhookPublicUrl` to the public URL
2. Ensure the proxy forwards requests to the webhook port

Example Nginx configuration:

```nginx
location /synology-chat-webhook {
    proxy_pass http://localhost:8789;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

## Troubleshooting

### Messages not being received

1. Check that the webhook server is running:
   ```bash
   curl http://localhost:8789/synology-chat-webhook
   ```
   Should return "Method Not Allowed" or similar

2. Verify the outgoing webhook URL in Synology Chat settings

3. Check OpenClaw logs for errors

### Messages not being sent

1. Verify `baseUrl` and `token` are correct
2. Test the incoming webhook manually:
   ```bash
   curl -X POST "https://nas.example.com:5001/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=\"your-token\"" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d 'payload={"text":"Test message"}'
   ```

### Pairing issues

If users can't pair:
1. Check `dmPolicy` is set to `pairing`
2. Ensure users are sending "yes" to confirm
3. Check OpenClaw logs for pairing state errors
