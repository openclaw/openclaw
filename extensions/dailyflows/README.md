# Dailyflows (plugin)

Dailyflows connects to OpenClaw via a webhook (your service -> Gateway).

## Install (dev)

```bash
openclaw plugins install -l ./extensions/dailyflows
```

Restart the Gateway after install/enabling.

## Config

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

Environment variables (preferred for secrets):

```bash
export DAILYFLOWS_WEBHOOK_SECRET="replace-with-random"
# Optional per-account override:
export DAILYFLOWS_WEBHOOK_SECRET_DEFAULT="replace-with-random"
```

## Public gateway URL (Tailscale Funnel)

Dailyflows calls the Gateway from Supabase Edge Functions, so the Gateway must be reachable over
public HTTPS. The recommended approach is Tailscale Funnel.

- Use a public `https://` gateway URL (for example: `https://your-host.tailnet.ts.net`).
- Prefer Tailscale Funnel to expose the Gateway HTTP server.

## Pairing (Dailyflows app)

1. Start the Gateway.
2. Open the pairing page:
   - `https://<gateway-host>/dailyflows/pair`
3. Scan the QR inside Dailyflows → Voice Assistant → OpenClaw.

CLI alternative:

```bash
openclaw dailyflows pair --gateway-url https://<your-funnel-url>
```

## Unpair (Dailyflows app)

Use Dailyflows → Voice Assistant → Disconnect OpenClaw to revoke the connection. The app calls the
`openclaw-unpair` Edge Function, which disables the Dailyflows account on the Gateway and clears
the stored webhook secret and outbound token.

## Webhook request (service -> Gateway)

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

## Outbound (Gateway -> Dailyflows)

The plugin sends replies to the configured outbound URL:

```
POST <outboundUrl>
Authorization: Bearer <outboundToken>
Content-Type: application/json
```
