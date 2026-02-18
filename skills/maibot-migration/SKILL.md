---
name: maibot-migration
description: Migrate MAIBOT (OpenClaw AI Assistant) to a new PC or cloud environment. Use when moving the entire MAIBOT setup — including OpenClaw gateway, workspace, all MAI projects, GPU pipeline, and credentials — to a different machine. Also use for environment recovery (Chrome debug reconnection, gsudo reinstall, dev tool repair). Handles environment detection, dependency installation, repo cloning, credential setup, productivity tools, Obsidian symlinks, cron jobs, and validation.
---

# MAIBOT Migration Skill

Migrate the complete MAIBOT environment to a new machine in one shot.

## What Gets Migrated

| Component          | Source                 | Method                     |
| ------------------ | ---------------------- | -------------------------- |
| OpenClaw Gateway   | npm registry           | `npm i -g openclaw`        |
| pnpm               | npm registry           | `npm i -g pnpm@10`         |
| EAS CLI            | npm registry           | `npm i -g eas-cli`         |
| MAIBOT workspace   | GitHub `jini92/MAIBOT` | `git clone` → `C:\MAIBOT`  |
| MAI projects (7개) | GitHub `jini92/*`      | `git clone` → `C:\TEST\*`  |
| OpenClaw config    | `~/.openclaw/`         | Export → import            |
| Obsidian vault     | OneDrive sync          | symlinks for project docs  |
| GPU pipeline       | Python venvs + vendor  | Conditional (if GPU)       |
| Credentials        | `.env` files           | Interactive or secure copy |
| Cron jobs          | OpenClaw gateway       | Re-register 4 jobs         |

## Migration Steps

### Step 1: Detect Target Environment

Check: OS, Node.js ≥22, Python ≥3.10, GPU (nvidia-smi), Git, disk space.

### Step 2: Install Dependencies

```powershell
# Node.js (if missing) — https://nodejs.org (v22+)
# Package managers & tools
npm i -g openclaw pnpm@10 eas-cli

# Verify
openclaw --version; pnpm --version; eas --version
```

### Step 3: Clone All Repositories

```powershell
# MAIBOT workspace
git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT

# MAI projects (C:\TEST\)
$projects = @("MAIBEAUTY","MAIOSS","MAISTAR7","MAICON","MAITUTOR","MAIBOTALKS","MAITOK")
foreach ($p in $projects) {
    git clone "https://github.com/jini92/$p.git" "C:\TEST\$p"
}
```

Note: MAISTAR7, MAICON repos may be TBD — skip if not yet created on GitHub.

### Step 4: Configure OpenClaw

```powershell
openclaw setup
# Or manually:
openclaw config set anthropic.apiKey <key>
openclaw config set discord.token <token>
openclaw config set gateway.mode local
```

#### Exec Auto-Approval

Set in `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "exec": {
      "security": "full",
      "ask": "off"
    }
  }
}
```

### Step 5: Set Up Credentials

Create `MAIBEAUTY/.env` with required keys. Copy from source machine or use interactive prompt.

### Step 6: GPU Pipeline (Optional)

Only if NVIDIA GPU available:

1. Python 3.10+ venvs: `.venv-tts`, `.venv-avatar`
2. SadTalker in `vendor/SadTalker`
3. ffmpeg in `vendor/ffmpeg`
4. edge-tts, boto3

### Step 7: Productivity Tools

#### gsudo (UAC-free Admin)

```powershell
winget install gerardog.gsudo --accept-package-agreements --accept-source-agreements
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
gsudo --version
```

Enables MAIBOT to run Admin commands remotely without UAC popup.

#### Chrome Remote Debugging (Browser Relay)

```powershell
$p = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($p)
$sc.Arguments = "--remote-debugging-port=18792"
$sc.Save()
```

- Port `18792` = OpenClaw default `cdpPort`
- Chrome must be restarted once after setup
- Survives Chrome updates (shortcut-based)

### Step 8: Obsidian Symlinks

Link project `docs/` folders into Obsidian vault for iPad access:

```powershell
$obsBase = "C:\Users\jini9\OneDrive\Documents\JINI_SYNC\01.PROJECT"
$links = @{
    "00.MAIBOT"     = "C:\MAIBOT\docs"
    "07.MAIBEAUTY"  = "C:\TEST\MAIBEAUTY\docs"
    "04.MAIOSS"     = "C:\TEST\MAIOSS\docs"
    "08.MAISTAR7"   = "C:\TEST\MAISTAR7\docs"
    "09.MAICON"     = "C:\TEST\MAICON\docs"
    "10.MAITUTOR"   = "C:\TEST\MAITUTOR\docs"
    "11.MAIBOTALKS" = "C:\TEST\MAIBOTALKS\docs"
    "12.MAITOK"     = "C:\TEST\MAITOK\docs"
}
foreach ($k in $links.Keys) {
    $target = "$obsBase\$k\docs"
    if (-not (Test-Path $target)) {
        gsudo cmd /c mklink /D "$target" $links[$k]
    }
}
```

### Step 9: Restore Cron Jobs

Re-register 4 cron jobs via OpenClaw:

| Job                            | Schedule  | Type               |
| ------------------------------ | --------- | ------------------ |
| Daily AI Monetization Briefing | 05:00 KST | isolated agentTurn |
| Daily AI Tech Briefing         | 05:05 KST | isolated agentTurn |
| Moltbot Update Check           | 05:10 KST | isolated agentTurn |
| 고혈압 약 복용 알림            | 06:00 KST | main systemEvent   |

All isolated jobs deliver to `channel:1466624220632059934` (Discord).

### Step 10: Validate

Verify:

- [ ] OpenClaw gateway starts
- [ ] All git repos accessible
- [ ] `gsudo --version` works
- [ ] Chrome debug port open (browse `http://127.0.0.1:18792/json`)
- [ ] Obsidian symlinks resolve
- [ ] API connectivity (Anthropic, Discord)
- [ ] Cron jobs listed (`openclaw cron list`)
- [ ] `pnpm test` passes in MAIBOT

## How to Use

### 방법 1: 원라인

```powershell
# Windows PowerShell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/jini92/MAIBOT/main/skills/maibot-migration/scripts/migrate.py" -OutFile migrate.py
python migrate.py full
```

### 방법 2: 레포 먼저 클론

```powershell
git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT
python C:\MAIBOT\skills\maibot-migration\scripts\migrate.py full
```

### 방법 3: Quick Migration

```powershell
npm i -g openclaw pnpm@10 eas-cli
git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT
openclaw setup
openclaw gateway start
# Then tell MAIBOT: "나머지 세팅해줘"
```

## Cloud Deployment Notes

- **Railway/Fly.io**: No GPU — chat + API only
- **RunPod/Lambda**: GPU available but costly
- **VPS (Hetzner/OVH)**: GPU servers at lower cost
- Headless: `openclaw gateway start --bind 0.0.0.0`

## Encoding Warning

**CRITICAL (Windows)**: Never use `Set-Content` for Korean text files. Always use:

```powershell
[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)
```

PowerShell 5 `Set-Content` defaults to CP949 → irreversible Korean character corruption.
