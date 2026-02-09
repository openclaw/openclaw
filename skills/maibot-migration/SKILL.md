---
name: maibot-migration
description: Migrate MAIBOT (OpenClaw AI Assistant) to a new PC or cloud environment. Use when moving the entire MAIBOT setup — including OpenClaw gateway, workspace (memory/skills/config), MAIBEAUTY project, GPU pipeline, and credentials — to a different machine. Handles environment detection, dependency installation, repo cloning, credential setup, and validation.
---

# MAIBOT Migration Skill

Migrate the complete MAIBOT environment to a new machine in one shot.

## What Gets Migrated

| Component         | Source                    | Method                                |
| ----------------- | ------------------------- | ------------------------------------- |
| OpenClaw Gateway  | npm registry              | `npm i -g openclaw`                   |
| MAIBOT workspace  | GitHub `jini92/MAIBOT`    | `git clone` (memory, skills, config)  |
| MAIBEAUTY project | GitHub `jini92/MAIBEAUTY` | `git clone` + `.env` setup            |
| OpenClaw config   | `~/.openclaw/`            | Export from source → import on target |
| GPU pipeline      | Python venvs + vendor     | Conditional setup (if GPU available)  |
| Credentials       | `.env` files              | Interactive prompt or secure copy     |

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
# Then install OpenClaw:
npm i -g openclaw

# Verify
openclaw --version
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

### Step 4: Configure OpenClaw

```bash
# Set up OpenClaw with API keys and channel config
openclaw setup
# Or manually:
openclaw config set anthropic.apiKey <key>
openclaw config set discord.token <token>
openclaw config set gateway.mode local
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

- OpenClaw gateway starts
- Git repos accessible
- API connectivity (MAIBEAUTY API, Cloudflare R2)
- GPU pipeline (if applicable)
- Discord channel connectivity

## How to Use (새 PC에서)

**사전 준비:** Node.js 22+, Git, Python 3.10+ 설치

### 방법 1: 원라인 (curl)

```bash
# Windows (PowerShell)
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/jini92/MAIBOT/main/skills/maibot-migration/scripts/migrate.py" -OutFile migrate.py
python migrate.py full

# macOS / Linux
curl -sL https://raw.githubusercontent.com/jini92/MAIBOT/main/skills/maibot-migration/scripts/migrate.py -o migrate.py
python migrate.py full
```

스크립트 하나만 다운로드하면 나머지(OpenClaw 설치, 레포 클론, .env 생성, 검증)는 자동 진행.

### 방법 2: 레포 먼저 클론

```bash
git clone https://github.com/jini92/MAIBOT.git
python MAIBOT/skills/maibot-migration/scripts/migrate.py full
```

### 방법 3: 단계별 수동 실행

```bash
python migrate.py detect      # 환경 체크
python migrate.py install     # 설치 + 클론
python migrate.py setup-env   # .env 생성
python migrate.py validate    # 검증
```

### Quick Migration (경험자용)

```bash
# 1. Install
npm i -g openclaw

# 2. Clone
git clone https://github.com/jini92/MAIBOT.git
git clone https://github.com/jini92/MAIBEAUTY.git

# 3. Configure
openclaw setup

# 4. Copy .env (from source machine)
# scp source:~/MAIBEAUTY/.env ~/MAIBEAUTY/.env

# 5. Start
openclaw gateway start
```

## Cloud Deployment Notes

- **Railway/Fly.io**: No GPU — chat + API only, no video generation
- **RunPod/Lambda**: GPU available — full pipeline possible, but costly
- **VPS (Hetzner/OVH)**: GPU servers available at lower cost
- For headless environments, use `openclaw gateway start --bind 0.0.0.0`
