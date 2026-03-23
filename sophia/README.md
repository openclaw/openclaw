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

Use the Render Blueprint URL for the repository you are currently reviewing. Replace
`<owner>/<repo>` with the GitHub repository path of that repo:
Go to:

```
https://render.com/deploy?repo=https://github.com/<owner>/<repo>
```

Example:

```
https://render.com/deploy?repo=https://github.com/openclaw/openclaw
```

Set `SETUP_PASSWORD` when prompted. Select Starter plan or above (persistent disk required).

### Step 2 — Add API keys as environment variables

In **Render Dashboard → your service → Environment** (or in the `Sophia-Claw` env group referenced by `render.yaml`), add:

- `SETUP_PASSWORD` — password for `/setup`

- `ANTHROPIC_API_KEY` — your Anthropic API key
- `OPENAI_API_KEY` — your OpenAI API key (for memory embeddings)
- `DEEPGRAM_API_KEY` — your Deepgram API key (inbound voice note transcription)
- `ELEVENLABS_API_KEY` — your ElevenLabs API key (outbound voice replies)

These are injected into the container process automatically. Never commit real keys to this repo.

### Step 3 — Know which config Render is actually using

This deployment does **not** use `/data/.openclaw/openclaw.json` as its primary config file.

Render starts OpenClaw with:

```bash
OPENCLAW_CONFIG_PATH=/app/sophia/openclaw.render.json
OPENCLAW_STATE_DIR=/data/.openclaw
```

That means:

- `sophia/openclaw.render.json` is the repo-backed source of truth for Sophia's deployment config
- secrets stay in Render environment variables
- config changes should be committed to git and deployed via a new Render deploy
- Render Shell is for operational tasks like WhatsApp login or inspection, not for `openclaw config set` mutations you want to keep

### Step 4 — Run the setup wizard

Navigate to `https://<your-service>.onrender.com/setup`, enter your password, select Anthropic as model provider and paste your key.

### Step 5 — Let OpenClaw seed Sophia's workspace

Sophia's workspace lives on the persistent disk at `/data/.openclaw/sophia`, but the initial seed files live in this repo under `sophia/`.

When the workspace is prepared, OpenClaw copies missing seed files from `/app/sophia/` into `/data/.openclaw/sophia/`, including:

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `AGENTS.md`
- `tone_skills.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `memory/`
- `avatars/`

Existing files on the persistent disk are **not** overwritten automatically, which is important for stateful files like `MEMORY.md`, `USER.md`, and anything Sophia updates over time.

If you want to force the initial seed immediately after deploy, you can open **Render Dashboard → your service → Shell** and run:

```bash
openclaw agent --message "Hello Sophia"
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

Then verify the voice layer end to end in WhatsApp:

- send a text message and confirm Sophia replies in text
- send a voice note and confirm Sophia replies with a voice note
- confirm the 💙 ack reaction appears promptly

Check **Render Dashboard → Logs** for real-time monitoring.

## What persists across redeploys

Everything under `/data/` survives:

- `/data/.openclaw/sophia/` — workspace, memory, seeded files, and avatars
- `/data/.openclaw/credentials/` — WhatsApp session (no re-scan needed)
- `/data/.openclaw/sessions/` — conversation history
  The main deployment config does **not** live under `/data/`; it is loaded from `sophia/openclaw.render.json` inside the deployed image on each release.

## Updating config and workspace files

Two options:

1. **Version-controlled changes**: Update `sophia/openclaw.render.json`, `sophia/*.md`, or `sophia/avatars/*` in this repo, then redeploy Render.
2. **Quick operational edits**: Edit files directly on `/data/.openclaw/sophia/` in Render Shell when you need an immediate local-only change.

If you change repo-backed seed files and want them to replace existing persistent files, do it deliberately in Render Shell. Automatic seeding only fills in missing files; it does not overwrite existing ones.
