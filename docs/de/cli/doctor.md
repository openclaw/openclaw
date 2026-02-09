---
summary: "CLI-Referenz für `openclaw doctor` (Gesundheitsprüfungen + geführte Reparaturen)"
read_when:
  - Sie haben Konnektivitäts-/Authentifizierungsprobleme und möchten geführte Lösungen
  - Sie haben aktualisiert und möchten einen Plausibilitätscheck
title: "doctor"
---

# `openclaw doctor`

Gesundheitsprüfungen + schnelle Korrekturen für Gateway und Kanäle.

Verwandt:

- Fehlerbehebung: [Troubleshooting](/gateway/troubleshooting)
- Sicherheitsprüfung: [Security](/gateway/security)

## Beispiele

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Hinweise:

- Interaktive Abfragen (wie Schlüsselbund-/OAuth-Korrekturen) werden nur ausgeführt, wenn stdin ein TTY ist und `--non-interactive` **nicht** gesetzt ist. Headless-Läufe (cron, Telegram, kein Terminal) überspringen Abfragen.
- `--fix` (Alias für `--repair`) schreibt ein Backup nach `~/.openclaw/openclaw.json.bak` und entfernt unbekannte Konfigurationsschlüssel, wobei jede Entfernung aufgelistet wird.

## macOS: `launchctl` Umgebungsvariablen-Overrides

Wenn Sie zuvor `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (oder `...PASSWORD`) ausgeführt haben, überschreibt dieser Wert Ihre Konfigurationsdatei und kann persistente „unauthorized“-Fehler verursachen.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
