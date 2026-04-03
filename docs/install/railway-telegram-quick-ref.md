---
summary: "Quick checklist for a Railway plus Telegram OpenClaw deployment"
read_when:
  - You already know the flow and only need the short version
title: "Railway plus Telegram Quick Reference"
---

Quick checklist for the full [Railway with Telegram](/install/railway-telegram-setup) guide.

## Quick start

1. Deploy OpenClaw on Railway.
2. Attach a volume at `/data`.
3. Set:

```bash
OPENCLAW_GATEWAY_PORT=8080
OPENCLAW_GATEWAY_TOKEN=<64-char-hex-token>
OPENCLAW_STATE_DIR=/data/.openclaw
OPENCLAW_WORKSPACE_DIR=/data/workspace
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
```

4. If using Groq, add `GROQ_API_KEY`.
5. Open `https://<your-domain>/openclaw`.
6. If the dashboard says `pairing required`, run:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

7. For a personal Telegram bot, prefer:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["<your-telegram-user-id>"],
    },
  },
}
```

## Common fixes

- `502` on Railway domain: check that public networking and service domains target `8080`
- `origin not allowed`: set `gateway.controlUi.allowedOrigins`
- `OpenClaw: access not configured` in Telegram: fix `dmPolicy` and `allowFrom`, or approve the Telegram pairing code
- `HTTP 401: Invalid API Key`: replace the model provider key, for example `GROQ_API_KEY`

## Related docs

- [Railway with Telegram](/install/railway-telegram-setup)
- [Railway](/install/railway)
- [Telegram](/channels/telegram)
- [Devices CLI](/cli/devices)
