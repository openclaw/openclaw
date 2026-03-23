# Sophia — AI Companion on OpenClaw

Sophia's workspace files and deployment config for running on OpenClaw.

## Files

- `SOUL.md` — Sophia's immutable identity. Never modified after deployment.
- `IDENTITY.md` — Sophia's self-description: name, vibe, theme, emoji.
- `USER.md` — Per-user profile. Sophia updates this as she learns about you.
- `AGENTS.md` — Full behavioral instructions: communication style, WhatsApp rules, tool policies, heartbeat tasks, memory lifecycle.
- `tone_skills.md` — Extra tone/style guidance injected into `Project Context` via the `bootstrap-extra-files` hook.
- `MEMORY.md` — Long-term memory. Sophia writes to this over time.
- `HEARTBEAT.md` — Task list executed every 2 hours: email scan, calendar check, open threads, memory maintenance.
- `memory/heartbeat-state.json` — Tracks last check timestamps.
- `openclaw.render.json` — Sanitized config template for Render deployment (no API keys).

`IDENTITY.md` is about Sophia. `USER.md` is about Davide.

## Deploy to Render

### Step 1 — Deploy from this fork

Go to:

```
https://render.com/deploy?repo=https://github.com/davidelaverga/openclaw
```

Set `SETUP_PASSWORD` when prompted. Select Starter plan or above (persistent disk required).

### Step 2 — Add API keys as environment variables

In **Render Dashboard → your service → Environment**, add:

- `ANTHROPIC_API_KEY` — your Anthropic API key
- `OPENAI_API_KEY` — your OpenAI API key (for memory embeddings)

These are injected into the container process automatically. Never commit real keys to this repo.

### Step 3 — Run the setup wizard

Navigate to `https://<your-service>.onrender.com/setup`, enter your password, select Anthropic as model provider and paste your key.

### Step 4 — Set up Sophia's workspace via Render Shell

Open **Render Dashboard → your service → Shell**, then:

```bash
# Create the workspace directory on the persistent disk
mkdir -p /data/.openclaw/sophia/memory

# Copy workspace files from the container (repo files are baked into the image)
cp /app/sophia/SOUL.md /data/.openclaw/sophia/
cp /app/sophia/IDENTITY.md /data/.openclaw/sophia/
cp /app/sophia/USER.md /data/.openclaw/sophia/
cp /app/sophia/AGENTS.md /data/.openclaw/sophia/
cp /app/sophia/tone_skills.md /data/.openclaw/sophia/
cp /app/sophia/MEMORY.md /data/.openclaw/sophia/
cp /app/sophia/HEARTBEAT.md /data/.openclaw/sophia/
cp /app/sophia/memory/heartbeat-state.json /data/.openclaw/sophia/memory/
```

### Step 5 — Apply Sophia config

Still in Render Shell, apply the Sophia-specific configuration:

```bash
# Set workspace path
openclaw config set agents.defaults.workspace /data/.openclaw/sophia

# Set model
openclaw config set agents.defaults.model.primary anthropic/claude-sonnet-4-6

# Set identity
openclaw config set agents.list.0.identity.name Sophia
openclaw config set agents.list.0.identity.theme "AI companion"

# Set memory search (uses OPENAI_API_KEY from env)
openclaw config set agents.defaults.memorySearch.provider openai
openclaw config set agents.defaults.memorySearch.model text-embedding-3-small

# Set heartbeat
openclaw config set agents.defaults.heartbeat.every 2h
openclaw config set agents.defaults.heartbeat.target whatsapp

# Enable cron
openclaw config set cron.enabled true

# Configure WhatsApp
openclaw config set channels.whatsapp.enabled true
openclaw config set channels.whatsapp.dmPolicy pairing
openclaw config set channels.whatsapp.groupPolicy allowlist

# IMPORTANT: Replace with your real phone number
openclaw config set channels.whatsapp.allowFrom '["+393519168570"]'
```

### Step 6 — Link WhatsApp

```bash
openclaw channels login --channel whatsapp
```

Scan the QR code with your phone: **WhatsApp → Linked Devices → Link a Device**.

WhatsApp credentials save to `/data/.openclaw/credentials/` on the persistent disk, so they survive redeploys.

### Step 7 — Verify

```bash
openclaw channels status --probe
openclaw agent --message "Hello Sophia"
```

Sophia should respond in character. Check **Render Dashboard → Logs** for real-time monitoring.

## What persists across redeploys

Everything under `/data/` survives:

- `/data/.openclaw/openclaw.json` — your config
- `/data/.openclaw/sophia/` — all workspace and memory files
- `/data/.openclaw/credentials/` — WhatsApp session (no re-scan needed)
- `/data/.openclaw/sessions/` — conversation history

## Updating workspace files

Two options:

1. **Quick edits**: Edit directly in Render Shell on `/data/.openclaw/sophia/`
2. **Version-controlled**: Update files in this repo, redeploy, then re-copy from `/app/sophia/` to `/data/.openclaw/sophia/` (be careful not to overwrite MEMORY.md or USER.md if Sophia has updated them)
