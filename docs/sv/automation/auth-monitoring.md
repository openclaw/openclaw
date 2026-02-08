---
summary: "Övervaka OAuth-utgång för modellleverantörer"
read_when:
  - Konfigurering av övervakning eller aviseringar för auth‑utgång
  - Automatisering av kontroller för OAuth‑uppdatering i Claude Code / Codex
title: "Auth‑övervakning"
x-i18n:
  source_path: automation/auth-monitoring.md
  source_hash: eef179af9545ed7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:06Z
---

# Auth‑övervakning

OpenClaw exponerar OAuth‑utgångshälsa via `openclaw models status`. Använd detta för
automatisering och aviseringar; skript är valfria tillägg för telefonarbetsflöden.

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

Dessa finns under `scripts/` och är **valfria**. De förutsätter SSH‑åtkomst till
gateway‑värden och är anpassade för systemd + Termux.

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
