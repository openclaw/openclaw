---
summary: "Overvåg OAuth-udløb for modeludbydere"
read_when:
  - Opsætning af overvågning eller alarmer for auth-udløb
  - Automatisering af Claude Code / Codex OAuth-opdateringstjek
title: "Autentificeringsovervågning"
x-i18n:
  source_path: automation/auth-monitoring.md
  source_hash: eef179af9545ed7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:47Z
---

# Autentificeringsovervågning

OpenClaw eksponerer OAuth-udløbsstatus via `openclaw models status`. Brug dette til
automatisering og alarmering; scripts er valgfrie ekstraer til telefon-workflows.

## Foretrukken: CLI-tjek (portabelt)

```bash
openclaw models status --check
```

Afslutningskoder:

- `0`: OK
- `1`: udløbne eller manglende legitimationsoplysninger
- `2`: udløber snart (inden for 24 timer)

Dette fungerer i cron/systemd og kræver ingen ekstra scripts.

## Valgfrie scripts (drift / telefon-workflows)

Disse ligger under `scripts/` og er **valgfrie**. De forudsætter SSH-adgang til
gateway-værten og er tilpasset systemd + Termux.

- `scripts/claude-auth-status.sh` bruger nu `openclaw models status --json` som den
  autoritative kilde (med fallback til direkte fil-læsning, hvis CLI’en ikke er tilgængelig),
  så behold `openclaw` på `PATH` til timere.
- `scripts/auth-monitor.sh`: cron/systemd-timermål; sender alarmer (ntfy eller telefon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd-brugertimer.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw auth-tjekker (fuld/json/enkelt).
- `scripts/mobile-reauth.sh`: guidet re-autentificeringsflow via SSH.
- `scripts/termux-quick-auth.sh`: status for widget med ét tryk + åbn auth-URL.
- `scripts/termux-auth-widget.sh`: fuldt guidet widget-flow.
- `scripts/termux-sync-widget.sh`: synkroniser Claude Code-legitimationsoplysninger → OpenClaw.

Hvis du ikke har brug for telefonaautomatisering eller systemd-timere, kan du springe disse scripts over.
