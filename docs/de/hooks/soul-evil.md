---
summary: "„SOUL-Evil-Hook (tauscht SOUL.md gegen SOUL_EVIL.md aus)“"
read_when:
  - Sie möchten den SOUL-Evil-Hook aktivieren oder abstimmen
  - Sie möchten ein Bereinigungsfenster oder einen zufallsbasierten Persona-Wechsel
title: "SOUL-Evil-Hook"
---

# SOUL-Evil-Hook

Der SOUL-Evil-Hook tauscht den **injizierten** `SOUL.md`-Inhalt während
eines Bereinigungsfensters oder per Zufall durch `SOUL_EVIL.md` aus. Er ändert **keine**
Dateien auf der Festplatte.

## Funktionsweise

Wenn `agent:bootstrap` ausgeführt wird, kann der Hook den `SOUL.md`-Inhalt im Speicher ersetzen,
bevor der System-Prompt zusammengestellt wird. Wenn `SOUL_EVIL.md` fehlt oder leer ist,
protokolliert OpenClaw eine Warnung und behält den normalen `SOUL.md` bei.

Ausführungen von Sub-Agenten enthalten `SOUL.md` nicht in ihren Bootstrap-Dateien,
daher hat dieser Hook keine Wirkung auf Sub-Agenten.

## Aktivieren

```bash
openclaw hooks enable soul-evil
```

Setzen Sie dann die Konfiguration:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Erstellen Sie `SOUL_EVIL.md` im Stammverzeichnis des Agent-Workspace (neben `SOUL.md`).

## Optionen

- `file` (string): alternativer SOUL-Dateiname (Standard: `SOUL_EVIL.md`)
- `chance` (number 0–1): zufällige Wahrscheinlichkeit pro Lauf, `SOUL_EVIL.md` zu verwenden
- `purge.at` (HH:mm): täglicher Beginn der Bereinigung (24-Stunden-Format)
- `purge.duration` (duration): Länge des Fensters (z. B. `30s`, `10m`, `1h`)

**Priorität:** Das Bereinigungsfenster hat Vorrang vor der Zufallschance.

**Zeitzone:** Verwendet `agents.defaults.userTimezone`, wenn gesetzt; andernfalls die Zeitzone des Hosts.

## Hinweise

- Es werden keine Dateien auf der Festplatte geschrieben oder verändert.
- Wenn `SOUL.md` nicht in der Bootstrap-Liste enthalten ist, bewirkt der Hook nichts.

## Siehe auch

- [Hooks](/automation/hooks)
