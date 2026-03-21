# @openclaw/synology-chat

Synology Chat channel plugin for OpenClaw. Connects your Synology NAS Chat to
OpenClaw via outgoing and incoming webhooks, with full agent capabilities.

## Install (local checkout)

```bash
openclaw plugins install ./extensions/synology-chat
```

## Install (npm)

```bash
openclaw plugins install @openclaw/synology-chat
```

Onboarding: select Synology Chat and confirm the install prompt to fetch the
plugin automatically.

## Config

Minimal config (single-account):

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      token: "your-outgoing-webhook-token",
      incomingUrl: "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22your-incoming-token%22",
      dmPolicy: "allowlist",
      allowedUserIds: ["123456"],
    },
  },
}
```

Multi-account config:

```json5
{
  channels: {
    "synology-chat": {
      enabled: true,
      accounts: {
        default: {
          token: "outgoing-token-1",
          incomingUrl: "https://nas.example.com/webapi/entry.cgi?...",
          allowedUserIds: ["123456"],
        },
        secondary: {
          token: "outgoing-token-2",
          incomingUrl: "https://nas2.example.com/webapi/entry.cgi?...",
          allowedUserIds: ["789012"],
        },
      },
    },
  },
}
```

### Config fields

| Field                | Default             | Description                                               |
| -------------------- | ------------------- | --------------------------------------------------------- |
| `token`              | (required)          | Outgoing webhook secret token from Synology Chat          |
| `incomingUrl`        | (required)          | Incoming webhook URL for sending replies                  |
| `nasHost`            | `""`                | NAS hostname (informational)                              |
| `webhookPath`        | `/webhook/synology` | Path the gateway listens on for outgoing webhook POSTs    |
| `dmPolicy`           | `"allowlist"`       | `"open"`, `"allowlist"`, or `"disabled"`                  |
| `allowedUserIds`     | `[]`                | Numeric Synology Chat user IDs allowed to message the bot |
| `rateLimitPerMinute` | (default)           | Per-user rate limit                                       |
| `botName`            | `""`                | Display name override                                     |
| `allowInsecureSsl`   | `false`             | Skip TLS verification (for self-signed NAS certs only)    |

### Environment variables

The outgoing webhook token can be set via the `SYNOLOGY_CHAT_TOKEN` environment
variable instead of placing it in config. Use `--use-env` during setup.

## Setup

1. Open **Synology Chat** on your NAS and go to **Integration** settings.
2. Create an **Incoming Webhook** and copy the generated URL into the
   `incomingUrl` config field.
3. Create an **Outgoing Webhook**:
   - Set the trigger URL to `https://<gateway-host>/webhook/synology`
     (or your custom `webhookPath`).
   - Copy the token into the `token` config field.
4. Add your Synology Chat user ID to `allowedUserIds` (or set
   `dmPolicy: "open"` for unrestricted access).
5. Start or restart the gateway.

## Full documentation

See https://docs.openclaw.ai/channels/synology-chat for:

- Access control and DM policy details
- Multi-account configuration
- Pairing and allowlist management
- Troubleshooting
