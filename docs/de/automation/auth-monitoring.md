---
summary: "OAuth-Ablauf für Modellanbieter überwachen"
read_when:
  - Einrichten der Überwachung oder von Warnmeldungen zum Auth-Ablauf
  - Automatisieren von Prüfungen zur OAuth-Aktualisierung für Claude Code / Codex
title: "Auth-Überwachung"
---

# Auth-Überwachung

OpenClaw stellt den OAuth-Ablaufstatus über `openclaw models status` bereit. Verwenden Sie dies für
Automatisierung und Alarmierung; Skripte sind optionale Extras für Telefon‑Workflows.

## Bevorzugt: CLI‑Prüfung (portabel)

```bash
openclaw models status --check
```

Exit-Codes:

- `0`: OK
- `1`: abgelaufene oder fehlende Anmeldedaten
- `2`: läuft bald ab (innerhalb von 24 Std.)

Dies funktioniert mit cron/systemd und erfordert keine zusätzlichen Skripte.

## Optionale Skripte (Ops‑/Telefon‑Workflows)

Diese befinden sich unter `scripts/` und sind **optional**. Sie setzen SSH‑Zugriff auf den
Gateway-Host voraus und sind für systemd + Termux abgestimmt.

- `scripts/claude-auth-status.sh` verwendet nun `openclaw models status --json` als
  maßgebliche Quelle (mit Fallback auf direkte Dateizugriffe, falls die CLI nicht verfügbar ist);
  halten Sie daher `openclaw` auf `PATH` für Timer.
- `scripts/auth-monitor.sh`: Ziel für cron/systemd‑Timer; sendet Warnmeldungen (ntfy oder Telefon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: systemd‑Benutzer‑Timer.
- `scripts/claude-auth-status.sh`: Auth‑Checker für Claude Code + OpenClaw (vollständig/json/einfach).
- `scripts/mobile-reauth.sh`: geführter Re‑Auth‑Ablauf über SSH.
- `scripts/termux-quick-auth.sh`: Ein‑Klick‑Widget‑Status + Öffnen der Auth‑URL.
- `scripts/termux-auth-widget.sh`: vollständig geführter Widget‑Ablauf.
- `scripts/termux-sync-widget.sh`: Synchronisierung von Claude‑Code‑Anmeldedaten → OpenClaw.

Wenn Sie keine Telefon‑Automatisierung oder systemd‑Timer benötigen, überspringen Sie diese Skripte.
