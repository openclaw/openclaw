# MAIBOT Migration — Detailed Steps

## Step 1: Detect Target Environment

Check: OS, Node.js ≥22, Python ≥3.10, GPU (nvidia-smi), Git, disk space.

## Step 2: Install Dependencies

```powershell
# Node.js (if missing) — https://nodejs.org (v22+)
npm i -g openclaw pnpm@10 eas-cli
# Verify
openclaw --version; pnpm --version; eas --version
```

## Step 3: Clone All Repositories

```powershell
# MAIBOT workspace
git clone https://github.com/jini92/MAIBOT.git C:\MAIBOT

# MAI projects (C:\TEST\)
$projects = @("MAIBEAUTY","MAIOSS","MAISTAR7","MAICON","MAITUTOR","MAIBOTALKS","MAITOK","MAIAX","MAISECONDBRAIN","MAIPatent","MAITalkCart","MAITHINK","MAITCAD","MAITB","MAIPnID","M.AI.UPbit")
foreach ($p in $projects) {
    git clone "https://github.com/jini92/$p.git" "C:\TEST\$p"
}
# Auxiliary repos
git clone "https://github.com/jini92/botalks-web.git" "C:\TEST\botalks-web"
```

Note: Some repos may be TBD — skip if `git clone` fails.

## Step 3b: Install Claude Code CLI

```powershell
npm i -g @anthropic-ai/claude-code
claude login   # Claude Max account: jini92.lee@gmail.com
claude --version
```

## Step 3c: Python Environments

```powershell
# M.AI.UPbit (crypto analysis)
cd C:\TEST\M.AI.UPbit
pip install -e .

# MAISECONDBRAIN / Mnemo (knowledge graph)
cd C:\TEST\MAISECONDBRAIN
pip install -r requirements.txt
```

## Step 4: Configure OpenClaw

```powershell
openclaw setup
# Or manually:
openclaw config set anthropic.apiKey <key>
openclaw config set discord.token <token>
openclaw config set gateway.mode local
```

### Exec Auto-Approval

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

## Step 5: Set Up Credentials

Create `MAIBEAUTY/.env` with required keys. Copy from source machine or use interactive prompt.

## Step 6: GPU Pipeline (Optional)

Only if NVIDIA GPU available:

1. Python 3.10+ venvs: `.venv-tts`, `.venv-avatar`
2. SadTalker in `vendor/SadTalker`
3. ffmpeg in `vendor/ffmpeg`
4. edge-tts, boto3

See also: `references/gpu-setup.md`

## Step 7: Productivity Tools

### gsudo (UAC-free Admin)

```powershell
winget install gerardog.gsudo --accept-package-agreements --accept-source-agreements
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
gsudo --version
```

### Chrome Remote Debugging (Browser Relay)

```powershell
$p = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($p)
$sc.Arguments = "--remote-debugging-port=18792"
$sc.Save()
```

- Port `18792` = OpenClaw default `cdpPort`
- Chrome must be restarted once after setup

## Step 8: Obsidian Symlinks

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

## Step 9: Restore Cron Jobs

Re-register 21 cron jobs via OpenClaw. Key jobs:

| Job                      | Schedule        | Type               |
| ------------------------ | --------------- | ------------------ |
| AI 수익화 브리핑         | 03:00 KST daily | isolated agentTurn |
| AI 기술 브리핑           | 03:05 KST daily | isolated agentTurn |
| MAIBOT 업데이트 체크     | 03:10 KST daily | isolated agentTurn |
| 테크 인텔리전스          | 04:00 KST daily | isolated agentTurn |
| 사업화 인텔리전스        | 04:30 KST daily | isolated agentTurn |
| Mnemo 볼트 보강          | 05:00 KST daily | isolated agentTurn |
| 💊 약 리마인더           | 05:30 KST daily | main systemEvent   |
| M.AI.UPbit 시장 모니터링 | 05:30 KST daily | isolated agentTurn |
| 모닝 브리핑              | 06:00 KST daily | isolated agentTurn |
| M.AI.UPbit 일일 분석     | 06:30 KST daily | isolated agentTurn |
| M.AI.UPbit 퀀트 시즌     | 06:35 KST daily | isolated agentTurn |
| M.AI.UPbit 오전 자동매매 | 07:00 KST daily | isolated agentTurn |
| M.AI.UPbit 매매 평가     | 07:30 KST daily | isolated agentTurn |
| 오후 순찰                | 12:00 KST daily | isolated agentTurn |
| M.AI.UPbit 오후 자동매매 | 19:00 KST daily | isolated agentTurn |
| 주간 리뷰                | Mon 07:00 KST   | isolated agentTurn |
| 퀀트 모멘텀 리포트       | Mon 07:00 KST   | isolated agentTurn |
| 주간 기회 리뷰           | Mon 07:30 KST   | isolated agentTurn |
| M.AI.UPbit 주간 성과     | Mon 08:00 KST   | isolated agentTurn |
| Dependency Health        | Wed 10:00 KST   | isolated agentTurn |
| Friday Documentation     | Fri 10:00 KST   | isolated agentTurn |
| Monthly Full Check       | 1st Mon 09:00   | isolated agentTurn |

All isolated jobs deliver to `channel:1466624220632059934` (Discord DM).
Full schedule definitions in `HEARTBEAT.md`.

## Step 10: Validate

- [ ] OpenClaw gateway starts
- [ ] All git repos accessible
- [ ] `gsudo --version` works
- [ ] Chrome debug port open (`http://127.0.0.1:18792/json`)
- [ ] Obsidian symlinks resolve
- [ ] API connectivity (Anthropic, Discord)
- [ ] Cron jobs listed (`openclaw cron list`)
- [ ] `pnpm test` passes in MAIBOT

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
