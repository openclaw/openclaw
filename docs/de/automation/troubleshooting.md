---
summary: "Behebung von Problemen bei Cron- und Heartbeat-Planung und -Zustellung"
read_when:
  - Cron wurde nicht ausgeführt
  - Cron wurde ausgeführt, aber es wurde keine Nachricht zugestellt
  - Heartbeat wirkt stumm oder wurde übersprungen
title: "Fehlerbehebung bei Automatisierung"
---

# Fehlerbehebung bei Automatisierung

Verwenden Sie diese Seite bei Problemen mit dem Scheduler und der Zustellung (`cron` + `heartbeat`).

## Befehlsleiter

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Führen Sie dann die Automatisierungsprüfungen aus:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron wird nicht ausgelöst

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Gute Ausgabe sieht so aus:

- `cron status` meldet aktiviert und einen zukünftigen `nextWakeAtMs`.
- Job ist aktiviert und hat einen gültigen Zeitplan/eine gültige Zeitzone.
- `cron runs` zeigt `ok` oder einen expliziten Überspring-Grund.

Häufige Signaturen:

- `cron: scheduler disabled; jobs will not run automatically` → Cron in Konfiguration/Umgebungsvariablen deaktiviert.
- `cron: timer tick failed` → Scheduler-Tick abgestürzt; umliegenden Stack-/Log-Kontext prüfen.
- `reason: not-due` in der Run-Ausgabe → manueller Lauf ohne `--force` aufgerufen und Job ist noch nicht fällig.

## Cron ausgelöst, aber keine Zustellung

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Gute Ausgabe sieht so aus:

- Run-Status ist `ok`.
- Zustellmodus/Ziel sind für isolierte Jobs gesetzt.
- Kanalprobe meldet Zielkanal als verbunden.

Häufige Signaturen:

- Lauf erfolgreich, aber Zustellmodus ist `none` → es wird keine externe Nachricht erwartet.
- Zustellziel fehlt/ist ungültig (`channel`/`to`) → Lauf kann intern erfolgreich sein, überspringt aber ausgehende Zustellung.
- Kanal-Auth-Fehler (`unauthorized`, `missing_scope`, `Forbidden`) → Zustellung durch Kanal-Anmeldedaten/Berechtigungen blockiert.

## Heartbeat unterdrückt oder übersprungen

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Gute Ausgabe sieht so aus:

- Heartbeat aktiviert mit einem Intervall ungleich Null.
- Letztes Heartbeat-Ergebnis ist `ran` (oder der Überspring-Grund ist bekannt).

Häufige Signaturen:

- `heartbeat skipped` mit `reason=quiet-hours` → außerhalb von `activeHours`.
- `requests-in-flight` → Hauptspur beschäftigt; Heartbeat verzögert.
- `empty-heartbeat-file` → `HEARTBEAT.md` existiert, hat aber keinen umsetzbaren Inhalt.
- `alerts-disabled` → Sichtbarkeitseinstellungen unterdrücken ausgehende Heartbeat-Nachrichten.

## Zeitzone- und activeHours-Fallstricke

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Schnellregeln:

- `Config path not found: agents.defaults.userTimezone` bedeutet, dass der Schlüssel nicht gesetzt ist; Heartbeat fällt auf die Host-Zeitzone zurück (oder `activeHours.timezone`, falls gesetzt).
- Cron ohne `--tz` verwendet die Zeitzone des Gateway-Hosts.
- Heartbeat `activeHours` verwendet die konfigurierte Zeitzonenauflösung (`user`, `local` oder explizite IANA-TZ).
- ISO-Zeitstempel ohne Zeitzone werden für Cron-`at`-Zeitpläne als UTC behandelt.

Häufige Signaturen:

- Jobs laufen zur falschen Uhrzeit nach Änderungen der Host-Zeitzone.
- Heartbeat wird tagsüber immer übersprungen, weil `activeHours.timezone` falsch ist.

Verwandt:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
