# OpenClaw — Email → Slack + Auto-Reply  |  Docker Setup Guide

Run OpenClaw in Docker to:
- 📬 **Poll Gmail every hour** automatically
- 💬 **Post a Slack notification** for every email digest
- 📨 **Auto-reply to new leads and customers** ("we've received your message, we're on it")
- 🌐 **View digest on the web dashboard** at `http://localhost:18789/digest`

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [Docker Desktop](https://docs.docker.com/desktop/) | v24+ recommended. Enable Docker Compose v2. |
| Gmail account | OAuth credentials via `gog` (set up during script) |
| Slack workspace | A Bot Token with `chat:write` + `channels:read` scopes |
| AI API key | Anthropic (`sk-ant-...`), OpenAI (`sk-...`), or Gemini |

---

## Quick Start (3 steps)

### Windows (PowerShell)

```powershell
# 1. Allow local scripts (one-time, if not already done)
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 2. Run the setup wizard
.\scripts\email-slack-setup.ps1

# 3. Trigger a manual test run
docker exec -it openclaw-email-digest `
  node openclaw.mjs agent --message "Run email-digest skill now"
```

### macOS / Linux (bash)

```bash
# 1. Run the setup wizard
chmod +x scripts/email-slack-setup.sh
./scripts/email-slack-setup.sh

# 2. Trigger a manual test run
docker exec -it openclaw-email-digest \
  node openclaw.mjs agent --message "Run email-digest skill now"
```

The setup wizard will ask you for:
- Your Gmail address
- An AI API key
- Your Slack Bot Token and Channel ID
- Whether to enable auto-replies

It then builds the images, starts the container, authenticates Gmail, and registers the hourly cron job — all automatically.

---

## Getting a Slack Bot Token

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From Scratch**
2. Name it anything (e.g. `OpenClaw Email Digest`)
3. Go to **OAuth & Permissions** → **Bot Token Scopes** → add:
   - `chat:write` — post messages
   - `channels:read` — list channels
4. Click **Install to Workspace**
5. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
6. Invite the bot to your channel: `/invite @YourBotName`

**Finding the Channel ID:**  
Right-click the Slack channel → **View channel details** → copy the ID at the bottom (e.g. `C0123456789`)

---

## Manual Setup (Step by Step)

If you prefer to run each step manually instead of using the setup script:

### 1. Copy and fill the environment file

```bash
cp .env.email-digest .env.email-digest.local   # keep the template
```

Edit `.env.email-digest` and fill in your values (see [Environment Variables](#environment-variables) below).

### 2. Build Docker images

```bash
# Build base image (required first)
docker build -t openclaw:local .

# Build email-digest image (adds gog + jq on top of base)
docker build -f Dockerfile.email-digest -t openclaw:email-digest .
```

### 3. Start the stack

```bash
docker compose -f docker-compose.email-digest.yml \
  --env-file .env.email-digest \
  up -d
```

### 4. Check the container is running

```bash
docker ps
# Should show: openclaw-email-digest  Up  0.0.0.0:18789->18789/tcp
```

### 5. Authenticate Gmail

```bash
docker exec -it openclaw-email-digest \
  gog auth add you@gmail.com --services gmail,calendar
```

Follow the browser OAuth flow. When done:

```bash
docker exec openclaw-email-digest gog auth list
# Should show: you@gmail.com  gmail, calendar
```

### 6. Connect Slack

```bash
docker exec -it openclaw-email-digest \
  node openclaw.mjs channels add --channel slack --token xoxb-YOUR-TOKEN
```

### 7. Register the hourly cron job

```bash
docker exec openclaw-email-digest \
  node openclaw.mjs cron add \
    --name "Hourly Email Digest" \
    --schedule "0 * * * *" \
    --message "Run the email-digest skill. Gmail account: you@gmail.com. Deliver digest to: Slack channel C0123456789. Save JSON to ~/.openclaw/digests/. Auto-reply to new leads and customers is ENABLED." \
    --session isolated
```

### 8. Test it manually

```bash
docker exec -it openclaw-email-digest \
  node openclaw.mjs agent --message "Run email-digest skill now"
```

Check your Slack channel — you should see the digest appear.

---

## How It Works

```
Every 60 minutes (cron: 0 * * * *)
       │
       ▼
  email-digest skill
       │
       ├── 1. Fetch last hour of Gmail (via gog)
       │
       ├── 2. Detect meeting invites → add to Google Calendar
       │
       ├── 3. Categorize emails
       │        New Leads / Customer Replies / Follow-ups / Internal / Noise
       │
       ├── 4. Auto-reply (if EMAIL_AUTOREPLY_ENABLED=true)
       │        → email-autorespond skill
       │        → sends "we've received your email, we're reviewing it"
       │        → skips internal mail and newsletters
       │
       ├── 5. Generate digest summary (markdown)
       │
       ├── 6. Save digest JSON → ~/.openclaw/digests/
       │
       └── 7. Deliver to:
                ├── Slack  → #your-channel
                ├── Dashboard → http://localhost:18789/digest
                ├── WhatsApp (if configured)
                └── Telegram (if configured)
```

---

## Auto-Reply Message

When `EMAIL_AUTOREPLY_ENABLED=true`, new leads and customer emails get this reply automatically:

> Hi [Name],
>
> Thank you for reaching out to us!
>
> We have received your email and our team is currently reviewing it. We will get back to you as soon as possible — typically within 24 hours on business days.
>
> If your matter is urgent, please feel free to reply to this email and let us know.
>
> Best regards,  
> The Team
>
> ---
> *This is an automated acknowledgement. A team member will follow up personally.*

**Auto-reply skips:**
- Internal emails (same domain)
- Newsletters and auto-notifications
- Threads already replied to in this session

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | Random auth token for the gateway (auto-generated by setup script) |
| `GOG_ACCOUNT` | ✅ | Gmail address to poll (e.g. `you@gmail.com`) |
| `ANTHROPIC_API_KEY` | ✅ (at least one AI key) | Anthropic API key |
| `OPENAI_API_KEY` | ✅ (at least one) | OpenAI API key |
| `SLACK_BOT_TOKEN` | ✅ for Slack | Bot token (`xoxb-...`) |
| `DIGEST_SLACK_CHANNEL` | ✅ for Slack | Channel ID (`C0123456789`) |
| `EMAIL_AUTOREPLY_ENABLED` | No | `true` to send acknowledgement replies |
| `EMAIL_AUTOREPLY_FROM` | No | Gmail address to send replies from (defaults to `GOG_ACCOUNT`) |
| `DIGEST_WHATSAPP_NUMBER` | No | WhatsApp number (e.g. `+2547XXXXXXXX`) |
| `DIGEST_TELEGRAM_CHAT` | No | Telegram chat (`@channel` or number) |
| `OPENCLAW_GATEWAY_PORT` | No | Gateway port (default: `18789`) |
| `OPENCLAW_CONFIG_DIR` | No | Config directory (default: `~/.openclaw`) |

---

## Common Commands

```bash
# View live logs
docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest logs -f

# Run digest manually right now
docker exec -it openclaw-email-digest \
  node openclaw.mjs agent --message "Run email-digest skill now"

# List all cron jobs
docker exec openclaw-email-digest node openclaw.mjs cron list

# Check Slack/channel status
docker exec openclaw-email-digest node openclaw.mjs channels status

# Stop everything
docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest down

# Restart after editing .env.email-digest
docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest restart

# Open a shell inside the container
docker exec -it openclaw-email-digest bash

# Re-authenticate Gmail (if token expires)
docker exec -it openclaw-email-digest gog auth add you@gmail.com --services gmail,calendar
```

---

## Troubleshooting

### Container won't start
```bash
docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest logs
```

### Gmail auth fails inside container
Run the auth command interactively (note the `-it` flag — it's required for the OAuth browser flow):
```bash
docker exec -it openclaw-email-digest gog auth add you@gmail.com --services gmail,calendar
```

### Slack messages not arriving
1. Check token: `docker exec openclaw-email-digest node openclaw.mjs channels status`
2. Verify bot is invited to the channel: `/invite @YourBotName` in Slack
3. Verify `DIGEST_SLACK_CHANNEL` is the channel **ID** (e.g. `C0123456789`), not the name

### No emails being fetched
```bash
# Test gog directly inside container
docker exec openclaw-email-digest gog gmail messages search "in:inbox" --max 5 --json
```

### Auto-replies sending to wrong people
Check that `EMAIL_AUTOREPLY_ENABLED=true` and that the sending address in `EMAIL_AUTOREPLY_FROM` is authenticated in gog:
```bash
docker exec openclaw-email-digest gog auth list
```

### Build fails with "Killed" (OOM)
Increase Docker Desktop memory to 4GB+: **Docker Desktop → Settings → Resources → Memory**

---

## Dashboard

The web dashboard is available at `http://localhost:18789/digest` once the container is running. It shows:
- Latest digest (formatted)
- Historical digests
- Email counts by category

---

## Updating

```bash
# Pull latest code, rebuild images
git pull
docker build -t openclaw:local .
docker build -f Dockerfile.email-digest -t openclaw:email-digest .
docker compose -f docker-compose.email-digest.yml --env-file .env.email-digest up -d
```

---

## File Reference

| File | Purpose |
|---|---|
| `Dockerfile` | Base OpenClaw Docker image |
| `Dockerfile.email-digest` | Extends base with `gog` + `jq` |
| `docker-compose.email-digest.yml` | Docker Compose service definition |
| `.env.email-digest` | Your local secrets/config (never commit this) |
| `scripts/email-slack-setup.sh` | One-command setup (Linux/macOS) |
| `scripts/email-slack-setup.ps1` | One-command setup (Windows PowerShell) |
| `skills/email-digest/SKILL.md` | Email digest skill instructions |
| `skills/email-autorespond/SKILL.md` | Auto-reply skill instructions |
