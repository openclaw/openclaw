---
summary: "OAuth-verval bewaken voor modelproviders"
read_when:
  - Auth-vervalbewaking of waarschuwingen instellen
  - Automatiseren van controles voor OAuth-vernieuwing van Claude Code / Codex
title: "Auth-bewaking"
---

# Auth-bewaking

OpenClaw stelt de OAuth-vervalstatus beschikbaar via `openclaw models status`. Gebruik dit voor
automatisering en waarschuwingen; scripts zijn optionele extra’s voor telefoonworkflows.

## Voorkeur: CLI-controle (portable)

```bash
openclaw models status --check
```

Exitcodes:

- `0`: OK
- `1`: verlopen of ontbrekende inloggegevens
- `2`: verloopt binnenkort (binnen 24 uur)

Dit werkt in cron/systemd en vereist geen extra scripts.

## Optionele scripts (ops / telefoonworkflows)

Deze bevinden zich onder `scripts/` en zijn **optioneel**. Ze gaan uit van SSH-toegang tot de
Gateway-host en zijn afgestemd op systemd + Termux.

- `scripts/claude-auth-status.sh` gebruikt nu `openclaw models status --json` als de
  bron van waarheid (met terugval op directe bestandlezing als de CLI niet beschikbaar is),
  dus houd `openclaw` op `PATH` voor timers.
- `scripts/auth-monitor.sh`: cron/systemd-timerdoel; verstuurt waarschuwingen (ntfy of telefoon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd-gebruikertimer.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw auth-checker (volledig/json/eenvoudig).
- `scripts/mobile-reauth.sh`: begeleide herauthenticatiestroom via SSH.
- `scripts/termux-quick-auth.sh`: status van widget met één tik + open auth-URL.
- `scripts/termux-auth-widget.sh`: volledige begeleide widgetstroom.
- `scripts/termux-sync-widget.sh`: synchroniseer Claude Code-inloggegevens → OpenClaw.

Als je geen telefoonautomatisering of systemd-timers nodig hebt, sla deze scripts over.
