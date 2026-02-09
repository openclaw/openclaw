---
summary: "Overvåg OAuth-udløb for modeludbydere"
read_when:
  - Opsætning af overvågning eller alarmer for auth-udløb
  - Automatisering af Claude Code / Codex OAuth-opdateringstjek
title: "Autentificeringsovervågning"
---

# Autentificeringsovervågning

OpenClaw udsætter OAuth udløbssundhed via `openclaw modeller status`. Brug det til
automatisering og advarsel; scripts er valgfri ekstra til telefonens arbejdsgange.

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

Disse lever under `scripts/` og er **valgfri**. De antager SSH adgang til
gateway vært og er indstillet til systemd + Termux.

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
