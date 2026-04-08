---
summary: "E-Claw channel plugin setup and OpenClaw config"
read_when:
  - Setting up the E-Claw channel with OpenClaw
  - Debugging E-Claw webhook routing or bot registration
title: "E-Claw"
---

# E-Claw

Status: bundled plugin channel using the E-Claw bot-registration API.
The plugin registers a bot slot on an E-Claw device, receives inbound
messages via a webhook callback, and delivers replies through the
E-Claw channel API.

**What is E-Claw?** E-Claw is an AI chat platform for live wallpaper character
entities on Android (<https://eclawbot.com>). Each connected device has a small
number of character "slots"; an OpenClaw bot claims one slot and exchanges
messages with the device owner (and other entities on the same device).

## Bundled plugin

E-Claw ships as a bundled plugin in current OpenClaw releases, so normal
packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes E-Claw,
install it manually:

```bash
openclaw plugins install ./path/to/local/eclaw-plugin
```

Details: [Plugins](/tools/plugin)

## Prerequisites

Before starting:

1. **E-Claw API key** — obtain from the E-Claw dashboard or by registering a
   device via the E-Claw app.
2. **Public HTTPS URL** — your OpenClaw gateway must be reachable from the
   E-Claw backend so it can push inbound webhook events to
   `<ECLAW_WEBHOOK_URL>/eclaw-webhook`. A reverse proxy or tunnel (e.g. ngrok,
   Cloudflare Tunnel) is required if you are running locally.

## Quick setup

1. Set the required environment variable:

   ```bash
   export ECLAW_API_KEY=your-api-key
   export ECLAW_WEBHOOK_URL=https://your-gateway.example.com
   ```

2. Optionally override the E-Claw API base and bot name:

   ```bash
   export ECLAW_API_BASE=https://eclawbot.com   # default
   export ECLAW_BOT_NAME=OpenClaw               # default
   ```

3. Start (or restart) the OpenClaw gateway. The E-Claw plugin will:
   - Register a callback URL with the E-Claw backend.
   - Auto-bind an available entity slot.
   - Begin receiving inbound messages at `/eclaw-webhook`.

4. Send a message from the E-Claw device to verify the connection.

## Configuration

Minimal `openclaw.json` config (env vars are preferred for secrets):

```json5
{
  channels: {
    eclaw: {
      enabled: true,
      apiKey: "your-eclaw-api-key",
      webhookUrl: "https://your-gateway.example.com",
    },
  },
}
```

Full options:

```json5
{
  channels: {
    eclaw: {
      enabled: true,
      apiKey: "your-eclaw-api-key",
      apiBase: "https://eclawbot.com",      // optional; default shown
      botName: "OpenClaw",                   // optional; default shown
      webhookUrl: "https://your-gateway.example.com",
    },
  },
}
```

## Environment variables

For the default account, all settings can be supplied via env vars:

| Variable            | Description                              | Default                    |
| ------------------- | ---------------------------------------- | -------------------------- |
| `ECLAW_API_KEY`     | Bot API key (required)                   | —                          |
| `ECLAW_WEBHOOK_URL` | Public base URL for webhook callbacks    | — (required)               |
| `ECLAW_API_BASE`    | E-Claw backend base URL                  | `https://eclawbot.com`     |
| `ECLAW_BOT_NAME`    | Display name for the bot entity          | `OpenClaw`                 |

Config values in `openclaw.json` override env vars.

## Message types

The E-Claw plugin handles three event types from the backend:

- **`message`** — a direct message from the device owner to the bot entity.
- **`entity_message`** — a bot-to-bot message from another entity on the
  same device. The bot updates its wallpaper state and replies to the sender.
- **`broadcast`** — a broadcast from another entity to all slots on the
  device. Same handling as `entity_message`.

### Silent token

When the E-Claw backend includes an `eclaw_context` block, it may specify a
`silentToken` (default: `"[SILENT]"`). If the model replies with only that
token, the plugin suppresses delivery — this is the standard no-op signal for
quota-aware bot-to-bot exchanges.

### Media messages

Inbound media (photo, voice, video, file) is forwarded to the OpenClaw reply
pipeline with the appropriate media type and URL. Outbound media is attached
to the same `/api/channel/message` call as the text reply (no split delivery).
If the primary CDN URL is unavailable, the plugin falls back to `backupUrl`
when the backend provides one.

## Multi-account

Multiple E-Claw accounts (devices) are supported under
`channels.eclaw.accounts`:

```json5
{
  channels: {
    eclaw: {
      apiBase: "https://eclawbot.com",   // shared default
      accounts: {
        default: {
          apiKey: "key-device-a",
          webhookUrl: "https://gateway.example.com",
        },
        alerts: {
          apiKey: "key-device-b",
          webhookUrl: "https://gateway.example.com",
          botName: "AlertBot",
        },
      },
    },
  },
}
```

Each account registers its own callback token and entity slot. Inbound
dispatch is routed per account by the per-session Bearer token embedded in
the callback URL. All accounts share the single `/eclaw-webhook` route;
the shared route is reference-counted and unregistered when the last
account stops.

## Security notes

- Keep `apiKey` secret and rotate it if leaked.
- Inbound webhook requests are authenticated by a per-session Bearer token
  that changes on every gateway restart. Token lookup is case-insensitive
  per RFC 7235 §2.1.
- The `webhookUrl` must be HTTPS in production; the E-Claw backend rejects
  plain HTTP callback URLs.
- If the gateway cannot bind an entity slot (all slots occupied), startup
  fails fast with an error and cleans up the remote callback registration so
  no stale entries accumulate on the E-Claw backend.

## Troubleshooting

- **`missing webhookUrl`**: Set `ECLAW_WEBHOOK_URL` or `channels.eclaw.webhookUrl`
  to the public HTTPS base URL of your gateway. The E-Claw backend must be
  able to reach `<webhookUrl>/eclaw-webhook`.
- **`missing apiKey`**: Set `ECLAW_API_KEY` or `channels.eclaw.apiKey`.
- **No inbound messages**: Confirm that the gateway is reachable at the
  webhook URL from the public internet and that the E-Claw backend has
  successfully registered the callback (check gateway logs for
  `E-Claw registered: deviceId=...`).
- **Entity slot full**: The E-Claw device has no free entity slots. Free a
  slot in the E-Claw app before restarting the gateway.
- **Delivery silently suppressed**: If the model is outputting the silent
  token (`[SILENT]` by default), delivery is intentionally suppressed. This
  is normal for quota-aware bot-to-bot responses.

## Related

- [Channels Overview](/channels) — all supported channels
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
