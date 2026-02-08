---
summary: "I-monitor ang pag-expire ng OAuth para sa mga provider ng model"
read_when:
  - Pagse-set up ng monitoring o mga alert para sa pag-expire ng auth
  - Pag-automate ng mga check sa OAuth refresh ng Claude Code / Codex
title: "Auth Monitoring"
x-i18n:
  source_path: automation/auth-monitoring.md
  source_hash: eef179af9545ed7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
---

# Auth monitoring

Inilalantad ng OpenClaw ang kalagayan ng OAuth expiry sa pamamagitan ng `openclaw models status`. Gamitin ito para sa
automation at pag-alerto; opsyonal lamang ang mga script para sa mga workflow sa telepono.

## Inirerekomenda: CLI check (portable)

```bash
openclaw models status --check
```

Mga exit code:

- `0`: OK
- `1`: expired o nawawalang mga kredensyal
- `2`: malapit nang mag-expire (sa loob ng 24h)

Gumagana ito sa cron/systemd at hindi nangangailangan ng dagdag na mga script.

## Opsyonal na mga script (ops / mga workflow sa telepono)

Matatagpuan ang mga ito sa ilalim ng `scripts/` at **opsyonal**. Ipinapalagay nila ang SSH access sa
host ng gateway at naka-tune para sa systemd + Termux.

- Ang `scripts/claude-auth-status.sh` ay gumagamit na ngayon ng `openclaw models status --json` bilang
  source of truth (bumabalik sa direktang pagbasa ng file kung hindi available ang CLI),
  kaya panatilihin ang `openclaw` sa `PATH` para sa mga timer.
- `scripts/auth-monitor.sh`: target ng cron/systemd timer; nagpapadala ng mga alert (ntfy o telepono).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd user timer.
- `scripts/claude-auth-status.sh`: checker ng auth ng Claude Code + OpenClaw (full/json/simple).
- `scripts/mobile-reauth.sh`: ginabayang re‑auth flow sa pamamagitan ng SSH.
- `scripts/termux-quick-auth.sh`: status ng one‑tap widget + pagbubukas ng auth URL.
- `scripts/termux-auth-widget.sh`: kumpletong ginabayang widget flow.
- `scripts/termux-sync-widget.sh`: i-sync ang mga kredensyal ng Claude Code → OpenClaw.

Kung hindi mo kailangan ang phone automation o mga systemd timer, laktawan ang mga script na ito.
