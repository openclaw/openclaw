---
summary: "Övervaka OAuth-utgång för modellleverantörer"
read_when:
  - Konfigurering av övervakning eller aviseringar för auth‑utgång
  - Automatisering av kontroller för OAuth‑uppdatering i Claude Code / Codex
title: "Auth‑övervakning"
---

# Auth‑övervakning

OpenClaw avslöjar OAuth utgången hälsa via `openclaw models status`. Använd det för
automatisering och varning; skript är valfria extramaterial för telefonens arbetsflöden.

## Rekommenderat: CLI‑kontroll (portabel)

```bash
openclaw models status --check
```

Utgångskoder:

- `0`: OK
- `1`: utgångna eller saknade autentiseringsuppgifter
- `2`: löper snart ut (inom 24 h)

Detta fungerar i cron/systemd och kräver inga extra skript.

## Valfria skript (ops / telefonarbetsflöden)

Dessa lever under `scripts/` och är **valbara**. De antar SSH-åtkomst till
gateway-värden och är inställda för systemd + Termux.

- `scripts/claude-auth-status.sh` använder nu `openclaw models status --json` som
  sanningskälla (med fallback till direkta filläsningar om CLI inte är tillgängligt),
  så behåll `openclaw` på `PATH` för timers.
- `scripts/auth-monitor.sh`: mål för cron/systemd‑timer; skickar aviseringar (ntfy eller telefon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd‑användartimer.
- `scripts/claude-auth-status.sh`: Claude Code + OpenClaw‑auth‑kontroll (full/json/enkel).
- `scripts/mobile-reauth.sh`: guidad återautentiseringsprocess via SSH.
- `scripts/termux-quick-auth.sh`: statuswidget med ett tryck + öppna auth‑URL.
- `scripts/termux-auth-widget.sh`: fullständig guidad widget‑process.
- `scripts/termux-sync-widget.sh`: synka Claude Code‑uppgifter → OpenClaw.

Om du inte behöver telefonautomatisering eller systemd‑timers kan du hoppa över dessa skript.
