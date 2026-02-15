---
title: Deploy on Zeabur
---

Deploy OpenClaw on [Zeabur](https://zeabur.com) with a one-click template.
Zeabur runs the Gateway for you and provides a web terminal for configuration.

## Prerequisites

- A [Zeabur](https://zeabur.com) account (free tier is fine)
- A [Dedicated Server](https://zeabur.com/docs/dedicated-server)

## One-click deploy

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/VTZ4FX)

Click the button, fill in your domain, and you're done.

## Recommended resources

| Tier        | Spec              |
| ----------- | ----------------- |
| Minimum     | 2 vCPU / 4 GB RAM |
| Recommended | 4 vCPU / 8 GB RAM |

## Deploy steps

1. Click **Deploy on Zeabur** above.
2. Fill in your **Domain** (e.g. `my-openclaw`).
3. (Optional) Click **Generate** to create a Zeabur AI Hub API key, or skip this step.
4. Select **Dedicated Server** and choose your server, then click **Confirm**.

## First login

1. Go to your service's **Instructions** tab.
2. Copy the **Web UI (with token)** link and paste it into your browser's address bar.
3. Open **Chat** and send a test message to verify your AI model is working.

### Default model

| Deployment             | Default model                                  |
| ---------------------- | ---------------------------------------------- |
| With Zeabur AI Hub key | `zeabur-ai/gpt-5-mini`                         |
| Without                | `anthropic/claude-opus-4-5` (requires API key) |

You can change the default in **Settings > Agents > Default model**, or switch per-conversation with `/model <id>`.

## Connect Telegram

1. Message `@BotFather` in Telegram, run `/newbot`, copy the token.
2. Add `TELEGRAM_BOT_TOKEN` in your service's **Variables** tab, restart.
3. Send `/start` to your bot — it replies with a pairing code.
4. Approve via web chat (`openclaw pairing approve telegram <code>`) or via Zeabur **Command** terminal.

## Connect WhatsApp

1. Add WhatsApp config via Web UI Settings or chat:

   ```json
   {
     "channels": {
       "whatsapp": {
         "selfChatMode": true,
         "dmPolicy": "allowlist",
         "allowFrom": ["+15551234567"]
       }
     }
   }
   ```

   Replace the phone number with yours (include country code). Restart the service.

2. Open **Command** in Zeabur dashboard, run `openclaw channels login`, and scan the QR code with WhatsApp.

For Discord, Slack, and other channels see [Channels documentation](/channels).

## Data persistence

All data lives under `/home/node` (mounted as a persistent volume):

| Path                             | Purpose                       |
| -------------------------------- | ----------------------------- |
| `/home/node/.openclaw`           | Config, sessions, credentials |
| `/home/node/.openclaw/workspace` | Workspace and memory files    |

## Backup and restore

**Backup:** Open Zeabur **Command**, run `backup`. Download the archive from the **Files** tab.

**Restore:** Upload the archive to `/home/node` in **Files**, then run `restore <file>` (add `--strip 2` for Zeabur Backup Service files). Restart after restoring.

See also [Zeabur Backup Documentation](https://zeabur.com/docs/data-management/backup).

## Troubleshooting

### Config breaks the service

Switch the startup command to `/opt/openclaw/rescue.sh` and disable **Health Check**, then restart. Fix the config at `/home/node/.openclaw/openclaw.json` via **Command**, restore the original startup command (`/opt/openclaw/startup.sh && /opt/openclaw/start_gateway.sh`), re-enable health check, and restart.

### Health check connection refused

The service may still be initializing. Wait a few minutes, or increase resources if the error persists. Temporarily disable **Health Check** to stop restart loops and check logs.

### Update version

Go to **Settings > Service Image Source** and change `ghcr.io/openclaw/openclaw:<tag>`.
