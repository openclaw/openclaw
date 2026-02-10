---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Monitor OAuth expiry for model providers"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up auth expiry monitoring or alerts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Automating Claude Code / Codex OAuth refresh checks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Auth Monitoring"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Auth monitoring（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw exposes OAuth expiry health via `openclaw models status`. Use that for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
automation and alerting; scripts are optional extras for phone workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Preferred: CLI check (portable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status --check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exit codes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `0`: OK（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `1`: expired or missing credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `2`: expiring soon (within 24h)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This works in cron/systemd and requires no extra scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Optional scripts (ops / phone workflows)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These live under `scripts/` and are **optional**. They assume SSH access to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gateway host and are tuned for systemd + Termux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/claude-auth-status.sh` now uses `openclaw models status --json` as the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  source of truth (falling back to direct file reads if the CLI is unavailable),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  so keep `openclaw` on `PATH` for timers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/auth-monitor.sh`: cron/systemd timer target; sends alerts (ntfy or phone).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd user timer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw auth checker (full/json/simple).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/mobile-reauth.sh`: guided re‑auth flow over SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/termux-quick-auth.sh`: one‑tap widget status + open auth URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/termux-auth-widget.sh`: full guided widget flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scripts/termux-sync-widget.sh`: sync Claude Code creds → OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don’t need phone automation or systemd timers, skip these scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
