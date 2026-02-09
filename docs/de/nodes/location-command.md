---
summary: "„Standortbefehl für Nodes (location.get), Berechtigungsmodi und Hintergrundverhalten“"
read_when:
  - Hinzufügen von Standort-Node-Unterstützung oder einer Berechtigungs-UI
  - Entwerfen von Hintergrund-Standort- und Push-Flows
title: "„Standortbefehl“"
---

# Standortbefehl (Nodes)

## TL;DR

- `location.get` ist ein Node-Befehl (über `node.invoke`).
- Standardmäßig deaktiviert.
- Einstellungen verwenden einen Selektor: Aus / Während der Nutzung / Immer.
- Separater Schalter: Präziser Standort.

## Warum ein Selektor (nicht nur ein Schalter)

OS-Berechtigungen sind mehrstufig. Wir können in der App einen Selektor anbieten, aber das OS entscheidet weiterhin über die tatsächliche Erteilung.

- iOS/macOS: Benutzer können in Systemdialogen/Einstellungen **Während der Nutzung** oder **Immer** wählen. Die App kann eine Hochstufung anfordern, aber das OS kann die Einstellungen verlangen.
- Android: Hintergrund-Standort ist eine separate Berechtigung; ab Android 10+ erfordert sie oft einen Einstellungen-Flow.
- Präziser Standort ist eine separate Erteilung (iOS 14+ „Präzise“, Android „fine“ vs. „coarse“).

Der Selektor in der UI steuert unseren angeforderten Modus; die tatsächliche Erteilung liegt in den OS-Einstellungen.

## Einstellungsmodell

Pro Node-Gerät:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI-Verhalten:

- Auswahl von `whileUsing` fordert die Vordergrund-Berechtigung an.
- Auswahl von `always` stellt zuerst `whileUsing` sicher und fordert dann den Hintergrund an (oder leitet den Benutzer bei Bedarf zu den Einstellungen weiter).
- Wenn das OS die angeforderte Stufe verweigert, wird auf die höchste gewährte Stufe zurückgesetzt und ein Status angezeigt.

## Berechtigungszuordnung (node.permissions)

Optional. Der macOS-Node meldet `location` über die Berechtigungszuordnung; iOS/Android können dies weglassen.

## Befehl: `location.get`

Aufgerufen über `node.invoke`.

Parameter (empfohlen):

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

Antwort-Payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Fehler (stabile Codes):

- `LOCATION_DISABLED`: Selektor ist aus.
- `LOCATION_PERMISSION_REQUIRED`: Berechtigung für den angeforderten Modus fehlt.
- `LOCATION_BACKGROUND_UNAVAILABLE`: App ist im Hintergrund, aber es ist nur „Während der Nutzung“ erlaubt.
- `LOCATION_TIMEOUT`: kein Fix rechtzeitig.
- `LOCATION_UNAVAILABLE`: Systemfehler / keine Anbieter.

## Hintergrundverhalten (zukünftig)

Ziel: Das Modell kann den Standort auch anfordern, wenn der Node im Hintergrund ist, jedoch nur wenn:

- Der Benutzer **Immer** ausgewählt hat.
- Das OS den Hintergrund-Standort gewährt.
- Die App im Hintergrund für Standort ausgeführt werden darf (iOS-Hintergrundmodus / Android-Foreground-Service oder Sonderfreigabe).

Push-ausgelöster Flow (zukünftig):

1. Gateway sendet einen Push an den Node (stiller Push oder FCM-Daten).
2. Der Node wacht kurz auf und fordert den Standort vom Gerät an.
3. Der Node leitet die Payload an das Gateway weiter.

Hinweise:

- iOS: Immer-Berechtigung + Hintergrund-Standortmodus erforderlich. Stille Pushes können gedrosselt werden; rechnen Sie mit intermittierenden Fehlern.
- Android: Hintergrund-Standort kann einen Foreground-Service erfordern; andernfalls ist mit Ablehnung zu rechnen.

## Modell-/Tooling-Integration

- Tool-Oberfläche: Das Werkzeug `nodes` fügt die Aktion `location_get` hinzu (Node erforderlich).
- CLI: `openclaw nodes location get --node <id>`.
- Agent-Richtlinien: Nur aufrufen, wenn der Benutzer den Standort aktiviert hat und den Umfang versteht.

## UX-Text (vorgeschlagen)

- Aus: „Standortfreigabe ist deaktiviert.“
- Während der Nutzung: „Nur wenn OpenClaw geöffnet ist.“
- Immer: „Hintergrund-Standort erlauben. Erfordert Systemberechtigung.“
- Präzise: „Präzisen GPS-Standort verwenden. Deaktivieren, um einen ungefähren Standort zu teilen.“
