# Telegram Troubleshooting Guide

This guide covers common issues users encounter when running OpenClaw with Telegram, including long-polling crashes, bot responsiveness, and configuration errors.

## 1. Long-Polling Crashes

> [!WARNING]
> Symptoms: The gateway starts but crashes after a few seconds or minutes with `Polling Error` or `ETELEGRAM: 409 Conflict`.

**Why it happens:**
Telegram only allows *one* bot instance to poll for updates at a time. If you have:
1.  Another instance of OpenClaw running.
2.  Another bot (like a previous testing script) running with the same token.
3.  A webhook set on the bot (polling and webhooks cannot be active simultaneously).

**Solution 1: Use Webhook Mode (Recommended for Production)**
Webhook mode is more stable and efficient. You need a public URL (HTTPS) that Telegram can reach.

**Option A: Cloudflare Tunnel (Easiest)**
1.  Install `cloudflared`.
2.  Run: `cloudflared tunnel --url http://localhost:18789`
3.  Copy the `https://....trycloudflare.com` URL.
4.  Update config:
    ```json
    "channels": {
      "telegram": {
        "webhookUrl": "https://your-tunnel-url.trycloudflare.com/telegram/webhook",
        "webhookSecret": "random-secret-string"
      }
    }
    ```

**Option B: Tailscale Funnel (Secure)**
1.  Enable Tailscale Funnel for your machine.
2.  Update config similar to above.

**Option C: ngrok (Classic)**
1.  Run: `ngrok http 18789`
2.  Use the ngrok URL in your config.

**Solution 2: Delete Existing Webhook (Temporary Fix)**
If you want to stick with long-polling but it crashes because a webhook exists:
```bash
curl -X POST https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook
```
Then restart OpenClaw.

## 2. Bot Not Responding

> [!NOTE]
> Diagnostic Steps:
> 1. Check if the gateway receives the message (look at verbose logs).
> 2. Check if the bot can send messages.

**Diagnose with curl:**
```bash
# Test if your bot token is valid and bot is accessible
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe
```

**Common Causes & Fixes:**

| Cause | Fix |
| :--- | :--- |
| **Pending Updates** | If the bot ignored many old messages, they might be flooding in. Clear them: `curl https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook?drop_pending_updates=true` |
| **Wrong Bot Token** | Double-check `channels.telegram.botToken`. Ensure no extra spaces. |
| **Privacy Mode** | If in a group, BotFather > Bot Settings > Group Privacy > Turn OFF. (Otherwise bot only sees mentions) |
| **Allowlist Blocking** | Check `channels.telegram.allowFrom`. If set, add your User ID. |

**How to get Telegram User ID:**
Message `@userinfobot` on Telegram.

## 3. "Unsupported schema node" UI Error

> [!WARNING]
> Symptoms: You see `[Error: Unsupported schema node: ...]` in the logs when using fancy formatting.

**What it means:**
The current Telegram adapter might not support a specific markdown/HTML entity returned by the AI model.

**Workaround:**
1.  Ask the agent to "use plain text" or "avoid complex markdown".
2.  In `agents.defaults`, set `model` to one that follows instructions better regarding formatting.

## 4. Messages Delayed

**Possible Causes:**
1.  **Rate Limiting**: Telegram limits bots to ~30 messages/second. If you send huge bursts, you'll be throttled.
2.  **Long-Polling Timeout**: If your internet connection is flaky, long-polling might hang. Switch to Webhook.
3.  **Gateway Overload**: If running locally with local LLMs, the system might be too slow to process.

## 5. Group Mentions Not Working

> [!TIP]
> Ensure configuration matches your expectation.

**Config:**
```json
"channels": {
  "telegram": {
    "groups": {
      "*": { "requireMention": true } // Bot only responds when @mentioned
    }
  }
}
```

**Debugging:**
Run with verbose logs:
```bash
openclaw gateway --verbose
```
Watch for `[Telegram] Ignored message (no mention)`.

## 6. Webhook Not Working

**Checklist:**
- [ ] **HTTPS Required**: Telegram sending webhooks ONLY to HTTPS URLs.
- [ ] **Publicly Accessible**: Localhost won't work without a tunnel (ngrok/Cloudflare).
- [ ] **Correct Path**: The path must typically capture the request. OpenClaw listens at `/telegram/webhook`.
- [ ] **Secret Match**: `webhookSecret` in config MUST matches what you set (OpenClaw handles the setting automatically if you provide `webhookUrl`).

**Debug Command:**
Simulate a webhook (advanced):
```bash
curl -v -X POST http://localhost:18789/telegram/webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <YOUR_SECRET>" \
  -d '{"update_id":123,"message":{...}}'
```

## Best Practices

### Recommended Production Config

```json
{
  "channels": {
    "telegram": {
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "webhookUrl": "https://claw.example.com/telegram/webhook",
      "webhookSecret": "${TELEGRAM_WEBHOOK_SECRET}",
      "allowFrom": ["12345678"], // Your User ID
      "groups": {
        // Allow specific group
        "-100123456789": { "requireMention": false }
      }
    }
  }
}
```

### Environment Variables (.env)

Create a `.env` file in the directory where you run openclaw:
```bash
TELEGRAM_BOT_TOKEN=123456789:ABCDefGHI...
TELEGRAM_WEBHOOK_SECRET=my-super-secret-string-123
```

## High-Traffic Performance Tuning

For busy bots:
1.  **Use Webhooks**: Much lower latency and resource usage than polling.
2.  **`maxConnections`**: Set in `channels.telegram` (1-100) to control concurrent processing.
3.  **Cheap Model**: Use `claude-3-haiku` for general chatter to save costs.

## Getting Help

If you're still stuck:
1.  Run `openclaw doctor` to check your environment.
2.  Generate a diagnostic report.
3.  Join [Discord](https://discord.gg/clawd) or open a [GitHub Issue](https://github.com/openclaw/openclaw/issues).
4.  **Important**: Include `openclaw gateway --verbose` logs (scrubbed of tokens) in your report.
