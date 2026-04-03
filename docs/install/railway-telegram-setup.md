---
summary: "Deploy OpenClaw on Railway and use it from Telegram and the Control UI"
read_when:
  - You want a hosted Railway plus Telegram setup
  - You want the exact Railway and Telegram flow validated in a live deployment
title: "Railway with Telegram"
---

Deploy OpenClaw on Railway, connect it to Telegram, and use either the web Control UI or Telegram DMs as your main chat surface.

This guide is the detailed companion to [Railway](/install/railway). It focuses on the setup that was validated end-to-end in a live Railway deployment, including the Control UI, Telegram DM access, and the most common Railway-specific fixes.

If you already know the flow and only need the short version, use [Railway plus Telegram Quick Reference](/install/railway-telegram-quick-ref).

## Before you start

You need:

- a Railway account
- a Telegram account
- a Telegram bot token from `@BotFather`
- one model provider key, such as Groq

For the fastest personal setup, use:

- Railway for hosting
- Telegram for chat
- `dmPolicy: "allowlist"` for one-owner bots

## 1. Deploy OpenClaw on Railway

Start with [Railway](/install/railway), then make sure these Railway settings are correct.

### Required Railway settings

- Attach a Volume mounted at `/data`
- Enable public networking on port `8080`
- Set these variables:

```bash
OPENCLAW_GATEWAY_PORT=8080
OPENCLAW_GATEWAY_TOKEN=<64-char-hex-token>
OPENCLAW_STATE_DIR=/data/.openclaw
OPENCLAW_WORKSPACE_DIR=/data/workspace
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
```

If you are using Groq, also set:

```bash
GROQ_API_KEY=<your-groq-key>
```

If your provider key is invalid, OpenClaw still boots, but model requests fail later with provider auth errors.

### Generate a gateway token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 2. Open the Control UI

After deploy, open:

- `https://<your-railway-domain>/openclaw`

Log in with `OPENCLAW_GATEWAY_TOKEN`.

### If the dashboard says `pairing required`

That means the browser device identity reached the gateway, but the device was not approved yet.

Approve it from the gateway host:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

Then reload the dashboard.

If you are opening the dashboard from mobile, generate the URL on a trusted desktop first and keep the full URL, including `#token=...`, when transferring it.

### If the dashboard says `origin not allowed`

Add your public Railway domains to:

- `gateway.controlUi.allowedOrigins`

Example:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: [
        "https://your-service-production-a123.up.railway.app",
        "https://your-service-production-b456.up.railway.app",
      ],
    },
  },
}
```

This is required for public Control UI use behind Railway's proxy.

## 3. Create the Telegram bot

In Telegram, talk to `@BotFather` and run:

```text
/newbot
```

Save the bot token and put it in `TELEGRAM_BOT_TOKEN`.

If you want the bot to read all group messages, adjust privacy mode with `@BotFather`. For DM-only use, the default bot settings are fine.

## 4. Choose your Telegram DM access model

Telegram DMs can use one of these policies:

- `pairing`
- `allowlist`
- `open`
- `disabled`

For a one-owner Railway bot, prefer `allowlist` with your numeric Telegram user ID. It is more durable than re-approving pairing codes after environment resets.

Example:

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

If you prefer the default pairing flow instead, keep:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

Then approve the first DM with:

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

## 5. Find your Telegram user ID

You can get your numeric Telegram user ID by messaging your bot and calling the Bot API:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

Read `from.id` from the update payload.

If `getUpdates` returns nothing because your bot is using webhooks, follow the [Telegram channel guide](/channels/telegram) and use logs to read the same `from.id` value instead.

This ID is what you put in `channels.telegram.allowFrom`.

## 6. Start chatting from Telegram

Once Telegram access is configured:

1. open the bot chat
2. send `/start` or a plain message such as `hello`
3. wait for the bot reply
4. continue the conversation normally

Examples:

- `summarize this text`
- `write a short reply in English`
- `explain this error`

## 7. Validate the deployment

Use these checks after deploy or after config changes.

### Railway and Control UI checks

Open:

- `https://<your-domain>/healthz`
- `https://<your-domain>/openclaw`

Expected results:

- `/healthz` returns `200`
- `/openclaw` loads the dashboard login screen or dashboard itself

### Telegram checks

Expected runtime state:

- Telegram configured
- Telegram running
- mode `polling` or webhook if you configured webhook mode
- no `lastError`

## Railway-specific troubleshooting

### Public domain returns `502 Application failed to respond`

On Railway, OpenClaw's public wrapper listens on port `8080`.

Check:

- Railway public networking targets port `8080`
- every generated Railway service domain also targets port `8080`

If an older generated Railway domain still points at `3000`, it can stay broken while a newer one works. Update the stale domain or remove it.

### `HTTP 401: Invalid API Key`

This is usually your model provider key, not the gateway token.

Common example:

- invalid `GROQ_API_KEY`

Fix the provider key in Railway Variables, redeploy or restart, and test again.

### Telegram says `OpenClaw: access not configured`

That means Telegram DM access is still blocked by policy.

Use one of these:

- keep `dmPolicy: "pairing"` and approve the code with `openclaw pairing approve telegram <CODE>`
- or switch to `dmPolicy: "allowlist"` and add your numeric Telegram user ID to `allowFrom`

For personal bots on Railway, `allowlist` is the simpler long-term choice.

### Telegram bot is healthy but does not reply

Check these in order:

1. `TELEGRAM_BOT_TOKEN` is valid
2. your Telegram user ID is approved by pairing or allowlist
3. your model provider key is valid
4. the gateway shows Telegram `running: true`

### Dashboard pairing comes back after a redeploy

If the browser creates a new device identity or the old identity is not reused, the dashboard can request pairing again.

Approve the new request with:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

## Recommended production baseline

For a single-owner Railway plus Telegram deployment, this is a practical baseline:

```json5
{
  agents: {
    defaults: {
      workspace: "/data/workspace",
      model: {
        primary: "groq/llama-3.3-70b-versatile",
      },
    },
  },
  channels: {
    telegram: {
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["<your-telegram-user-id>"],
    },
  },
  gateway: {
    controlUi: {
      allowedOrigins: ["https://<your-railway-domain>"],
    },
  },
}
```

Replace the Telegram user ID and domain with your own values.

## Related docs

- [Railway plus Telegram Quick Reference](/install/railway-telegram-quick-ref)
- [Railway](/install/railway)
- [Telegram](/channels/telegram)
- [Pairing](/channels/pairing)
- [Devices CLI](/cli/devices)
- [Gateway troubleshooting](/gateway/troubleshooting)
