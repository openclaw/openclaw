---
summary: "CLI-Referenz für `openclaw channels` (Konten, Status, Login/Logout, Logs)"
read_when:
  - Sie möchten Kanal-Konten hinzufügen/entfernen (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (Plugin)/Signal/iMessage)
  - Sie möchten den Kanalstatus prüfen oder Kanal-Logs verfolgen
title: "Kanäle"
---

# `openclaw channels`

Verwalten Sie Chat-Kanal-Konten und deren Laufzeitstatus auf dem Gateway.

Zugehörige Dokumentation:

- Kanal-Anleitungen: [Channels](/channels/index)
- Gateway-Konfiguration: [Configuration](/gateway/configuration)

## Allgemeine Befehle

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Konten hinzufügen / entfernen

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tipp: `openclaw channels add --help` zeigt kanalspezifische Flags (Token, App-Token, signal-cli-Pfade usw.).

## Login / Logout (interaktiv)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Fehlerbehebung

- Führen Sie `openclaw status --deep` für eine breite Diagnose aus.
- Verwenden Sie `openclaw doctor` für geführte Korrekturen.
- `openclaw channels list` gibt `Claude: HTTP 403 ... user:profile` aus → der Nutzungs-Snapshot benötigt den Geltungsbereich `user:profile`. Verwenden Sie `--no-usage` oder stellen Sie einen claude.ai-Sitzungsschlüssel bereit (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), oder authentifizieren Sie sich erneut über die Claude Code CLI.

## Fähigkeitsabfrage

Rufen Sie Anbieter-Hinweise zu Fähigkeiten (Intents/Scopes, wo verfügbar) sowie statische Funktionsunterstützung ab:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Hinweise:

- `--channel` ist optional; lassen Sie es weg, um jeden Kanal aufzulisten (einschließlich Erweiterungen).
- `--target` akzeptiert `channel:<id>` oder eine rohe numerische Kanal-ID und gilt nur für Discord.
- Abfragen sind anbieterspezifisch: Discord-Intents + optionale Kanalberechtigungen; Slack Bot- + Benutzer-Scopes; Telegram Bot-Flags + Webhook; Signal-Daemon-Version; MS Teams App-Token + Graph-Rollen/Scopes (wo bekannt annotiert). Kanäle ohne Abfragen melden `Probe: unavailable`.

## Namen zu IDs auflösen

Lösen Sie Kanal-/Benutzernamen mithilfe des Anbieter-Verzeichnisses zu IDs auf:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Hinweise:

- Verwenden Sie `--kind user|group|auto`, um den Zieltyp zu erzwingen.
- Die Auflösung bevorzugt aktive Treffer, wenn mehrere Einträge denselben Namen teilen.
