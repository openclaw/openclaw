---
name: maibot-migration
description: Migrate MAIBOT (Moltbot AI Assistant) to a new PC or cloud environment. Use when moving the entire MAIBOT setup — including Moltbot gateway, workspace (memory/skills/config), MAIBEAUTY project, GPU pipeline, and credentials — to a different machine. Handles environment detection, dependency installation, repo cloning, credential setup, and validation.
---

# MAIBOT Migration Skill

Migrate the complete MAIBOT environment to a new machine in one shot.

## What Gets Migrated

| Component | Source | Method |
|-----------|--------|--------|
| Moltbot Gateway | npm registry | `npm i -g moltbot` |
| MAIBOT workspace | GitHub `jini92/MAIBOT` | `git clone` (memory, skills, config) |
| MAIBEAUTY project | GitHub `jini92/MAIBEAUTY` | `git clone` + `.env` setup |
| Moltbot config | `~/.clawdbot/` | Export from source → import on target |
| GPU pipeline | Python venvs + vendor | Conditional setup (if GPU available) |
| Credentials | `.env` files | Interactive prompt or secure copy |

## Migration Steps

### Step 1: Detect Target Environment

Run `scripts/migrate.py detect` on the target machine to check:
- OS (Windows/macOS/Linux)
- Node.js version (≥22 required)
- Python version (≥3.10 for GPU pipeline)
- GPU availability (nvidia-smi)
- Git installation
- Disk space

### Step 2: Install Dependencies

```bash
# Node.js (if missing) — refer to https://nodejs.org
# Then install Moltbot:
npm i -g moltbot

# Verify
moltbot --version
```

### Step 3: Clone Repositories

```bash
# MAIBOT workspace (memory, skills, soul)
git clone https://github.com/jini92/MAIBOT.git ~/MAIBOT
# or Windows: git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT

# MAIBEAUTY project
git clone https://github.com/jini92/MAIBEAUTY.git ~/MAIBEAUTY
# or Windows: git clone https://github.com/jini92/MAIBEAUTY.git C:\TEST\MAIBEAUTY
```

### Step 4: Configure Moltbot

```bash
# Set up Moltbot with API keys and channel config
moltbot setup
# Or manually:
moltbot config set anthropic.apiKey <key>
moltbot config set discord.token <token>
moltbot config set gateway.mode local
```

### Step 5: Set Up Credentials

Create `MAIBEAUTY/.env` with required keys. Run `scripts/migrate.py setup-env` for interactive prompt, or copy from source machine.

Required `.env` keys — see `references/env-template.md` for full list.

### Step 6: GPU Pipeline (Optional)

Only if the target has an NVIDIA GPU and video generation is needed:

1. Install Python 3.10+
2. Create venvs: `.venv-tts`, `.venv-avatar`
3. Install SadTalker in `vendor/SadTalker`
4. Install ffmpeg in `vendor/ffmpeg`
5. Install edge-tts, boto3

See `references/gpu-setup.md` for detailed instructions.

### Step 7: Validate

Run `scripts/migrate.py validate` to verify:
- Moltbot gateway starts
- Git repos accessible
- API connectivity (MAIBEAUTY API, Cloudflare R2)
- GPU pipeline (if applicable)
- Discord channel connectivity

## Quick Migration (Experienced)

```bash
# 1. Install
npm i -g moltbot

# 2. Clone
git clone https://github.com/jini92/MAIBOT.git
git clone https://github.com/jini92/MAIBEAUTY.git

# 3. Configure
moltbot setup

# 4. Copy .env (from source machine)
# scp source:~/MAIBEAUTY/.env ~/MAIBEAUTY/.env

# 5. Start
moltbot gateway run
```

## Cloud Deployment Notes

- **Railway/Fly.io**: No GPU — chat + API only, no video generation
- **RunPod/Lambda**: GPU available — full pipeline possible, but costly
- **VPS (Hetzner/OVH)**: GPU servers available at lower cost
- For headless environments, use `moltbot gateway run --bind 0.0.0.0`
