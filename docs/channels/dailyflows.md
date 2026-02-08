---
summary: "Dailyflows webhook channel setup"
read_when:
  - You want to connect Dailyflows to OpenClaw
---

# Dailyflows

Status: supported via plugin (webhook).

## Plugin required

Dailyflows ships as a plugin and is not bundled with the core install.

Install the plugin:

```bash
openclaw plugins install -l ./extensions/dailyflows
```

Restart the Gateway after installing or enabling plugins.

## Configure

Minimal example:

```json5
{
  channels: {
    dailyflows: {
      webhookPath: "/dailyflows/webhook",
      accounts: {
        default: {
          enabled: true,
          outboundUrl: "https://dailyflows.example.com/openclaw/outbound",
          outboundToken: "REPLACE_ME",
        },
      },
    },
  },
  plugins: {
    entries: {
      dailyflows: { enabled: true },
    },
  },
}
```

Secrets should use environment variables:

```bash
export DAILYFLOWS_WEBHOOK_SECRET="replace-with-random"
# Optional per-account override:
export DAILYFLOWS_WEBHOOK_SECRET_DEFAULT="replace-with-random"
```

## Public gateway URL (Tailscale Funnel)

Dailyflows calls the OpenClaw Gateway from Supabase Edge Functions, so the Gateway must be reachable
over public HTTPS. The recommended approach is Tailscale Funnel.

- Use a public `https://` gateway URL (for example: `https://your-host.tailnet.ts.net`).
- Prefer Tailscale Funnel to expose only the Gateway HTTP server.
- See: [Tailscale guide](/gateway/tailscale).

## Tailscale Funnel setup

This is a minimal, repeatable flow to expose the Gateway over HTTPS for Dailyflows pairing.

1. Install and log in to Tailscale on the Gateway host, then run `tailscale up`.

2. Configure OpenClaw for Funnel:

```bash
openclaw config set gateway.mode local
openclaw config set gateway.bind loopback
openclaw config set gateway.auth.mode password
openclaw config set gateway.auth.password "<your-strong-password>"
openclaw config set gateway.tailscale.mode funnel
```

3. Start the Gateway (pick a Funnel-supported port, such as 10000):

```bash
pnpm openclaw gateway run --bind loopback --port 10000 --force
```

4. Find your public Funnel URL:

```bash
tailscale funnel status --json
```

5. Open the pairing page:

```
https://<your-device>.<your-tailnet>.ts.net/dailyflows/pair
```

If Funnel setup fails, see [Tailscale guide](/gateway/tailscale).

## Pairing (Dailyflows app)

Use the Dailyflows app to scan a pairing QR from your Gateway:

1. Start the Gateway.
2. Open the pairing page in your browser:
   - `https://<gateway-host>/dailyflows/pair`
3. Scan the QR inside Dailyflows → Voice Assistant → OpenClaw.

CLI alternative:

```bash
openclaw dailyflows pair --gateway-url https://<your-funnel-url>
```

The QR pairing step configures:

- `channels.dailyflows.accounts.<id>.outboundUrl`
- `channels.dailyflows.accounts.<id>.outboundToken`
- `channels.dailyflows.accounts.<id>.webhookSecret`

## Unpair

From the Dailyflows app, choose Disconnect OpenClaw to revoke the connection. This calls the
`openclaw-unpair` Edge Function, which requests the Gateway to disable the Dailyflows account and
clear the stored webhook secret and outbound token.

## Webhook request

Endpoint: `POST /dailyflows/webhook`

Headers:

- `x-dailyflows-timestamp`: Unix ms
- `x-dailyflows-signature`: `v1=<hex-hmac-sha256>`
- `x-dailyflows-event`: `message.received`

Signature:

- Payload: `<timestamp>.<rawBody>`
- HMAC-SHA256 using the shared secret

Body (JSON):

```json
{
  "id": "evt_01J2XYZ",
  "type": "message.received",
  "occurredAt": 1723462345123,
  "accountId": "default",
  "message": {
    "messageId": "msg_abc123",
    "chatType": "direct",
    "senderId": "u_42",
    "senderName": "Alice",
    "conversationId": "c_99",
    "conversationName": "Alice",
    "text": "hello from dailyflows",
    "attachments": [
      {
        "type": "image",
        "url": "https://cdn.example.com/a.jpg",
        "name": "a.jpg",
        "mime": "image/jpeg",
        "size": 34567
      },
      {
        "type": "file",
        "url": "https://cdn.example.com/report.pdf",
        "name": "report.pdf",
        "mime": "application/pdf",
        "size": 123456
      },
      {
        "type": "audio",
        "url": "https://cdn.example.com/voice.m4a",
        "name": "voice.m4a",
        "mime": "audio/mp4",
        "size": 54321,
        "durationMs": 12000
      }
    ]
  }
}
```

## OpenClaw outbound (Gateway -> Dailyflows)

The plugin sends replies to the configured outbound URL:

```
POST <outboundUrl>
Authorization: Bearer <outboundToken>
Content-Type: application/json
```

Payload (JSON):

```json
{
  "accountId": "default",
  "conversationId": "user-id",
  "messageId": "oc_123",
  "text": "reply text",
  "replyToId": "msg_abc123",
  "attachments": [{ "type": "file", "url": "https://cdn.example.com/a.pdf" }]
}
```

## Related

- Plugins: [Plugins](/plugin)
