---
summary: „Globale Sprach-Aktivierungswörter (vom Gateway verwaltet) und wie sie über Nodes hinweg synchronisiert werden“
read_when:
  - „Änderung des Verhaltens oder der Standardwerte von Sprach-Aktivierungswörtern“
  - „Hinzufügen neuer Node-Plattformen, die eine Synchronisierung der Aktivierungswörter benötigen“
title: „Sprachaktivierung“
x-i18n:
  source_path: nodes/voicewake.md
  source_hash: eb34f52dfcdc3fc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:41Z
---

# Sprachaktivierung (Globale Aktivierungswörter)

OpenClaw behandelt **Aktivierungswörter als eine einzige globale Liste**, die vom **Gateway** (Netzwerk-Gateway) verwaltet wird.

- Es gibt **keine Node-spezifischen benutzerdefinierten Aktivierungswörter**.
- **Jede Node-/App-UI kann** die Liste bearbeiten; Änderungen werden vom Gateway gespeichert und an alle verteilt.
- Jedes Gerät behält weiterhin seinen eigenen **Schalter für Sprachaktivierung ein/aus** (lokale UX + Berechtigungen unterscheiden sich).

## Speicherung (Gateway-Host)

Aktivierungswörter werden auf der Gateway-Maschine gespeichert unter:

- `~/.openclaw/settings/voicewake.json`

Form:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protokoll

### Methoden

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` mit Parametern `{ triggers: string[] }` → `{ triggers: string[] }`

Hinweise:

- Trigger werden normalisiert (getrimmt, leere Einträge entfernt). Leere Listen fallen auf Standardwerte zurück.
- Zur Sicherheit werden Limits durchgesetzt (Begrenzungen für Anzahl/Länge).

### Events

- `voicewake.changed` Payload `{ triggers: string[] }`

Wer es erhält:

- Alle WebSocket-Clients (macOS-App, WebChat usw.)
- Alle verbundenen Nodes (iOS/Android) sowie zusätzlich beim Verbinden eines Nodes als initiale Push-Übermittlung des „aktuellen Zustands“.

## Client-Verhalten

### macOS-App

- Verwendet die globale Liste zur Steuerung von `VoiceWakeRuntime`-Triggern.
- Das Bearbeiten von „Trigger words“ in den Einstellungen zur Sprachaktivierung ruft `voicewake.set` auf und verlässt sich anschließend auf die Broadcasts, um andere Clients synchron zu halten.

### iOS-Node

- Verwendet die globale Liste für die Erkennung von `VoiceWakeManager`-Triggern.
- Das Bearbeiten der Aktivierungswörter in den Einstellungen ruft `voicewake.set` (über das Gateway-WS) auf und hält außerdem die lokale Aktivierungswort-Erkennung reaktionsfähig.

### Android-Node

- Stellt in den Einstellungen einen Editor für Aktivierungswörter bereit.
- Ruft `voicewake.set` über das Gateway-WS auf, damit Änderungen überall synchronisiert werden.
