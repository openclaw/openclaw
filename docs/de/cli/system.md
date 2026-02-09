---
summary: "CLI-Referenz für `openclaw system` (Systemereignisse, Heartbeat, Präsenz)"
read_when:
  - Sie möchten ein Systemereignis einreihen, ohne einen Cron-Job zu erstellen
  - Sie müssen Heartbeats aktivieren oder deaktivieren
  - Sie möchten System-Präsenzeinträge einsehen
title: "system"
---

# `openclaw system`

Systemweite Hilfsfunktionen für das Gateway: Systemereignisse einreihen, Heartbeats steuern
und Präsenz anzeigen.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Reihen Sie ein Systemereignis in der **main**-Sitzung ein. Der nächste Heartbeat fügt es
als eine `System:`-Zeile in den Prompt ein. Verwenden Sie `--mode now`, um den Heartbeat
sofort auszulösen; `next-heartbeat` wartet auf den nächsten geplanten Tick.

Flags:

- `--text <text>`: erforderlicher Text des Systemereignisses.
- `--mode <mode>`: `now` oder `next-heartbeat` (Standard).
- `--json`: maschinenlesbare Ausgabe.

## `system heartbeat last|enable|disable`

Heartbeat-Steuerung:

- `last`: zeigt das letzte Heartbeat-Ereignis an.
- `enable`: schaltet Heartbeats wieder ein (verwenden Sie dies, wenn sie deaktiviert waren).
- `disable`: pausiert Heartbeats.

Flags:

- `--json`: maschinenlesbare Ausgabe.

## `system presence`

Listet die aktuellen System-Präsenzeinträge auf, die dem Gateway bekannt sind (Nodes,
Instanzen und ähnliche Statuszeilen).

Flags:

- `--json`: maschinenlesbare Ausgabe.

## Hinweise

- Erfordert ein laufendes Gateway, das über Ihre aktuelle Konfiguration erreichbar ist (lokal oder remote).
- Systemereignisse sind ephemer und werden über Neustarts hinweg nicht persistiert.
