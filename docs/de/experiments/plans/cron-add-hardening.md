---
summary: "Eingabehärtung für cron.add, Schemaabgleich und Verbesserung der Cron-UI/Agent-Tooling"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Härtung von Cron Add"
---

# Härtung von Cron Add & Schemaabgleich

## Kontext

Aktuelle Gateway-Logs zeigen wiederholte `cron.add`-Fehler mit ungültigen Parametern (fehlende `sessionTarget`, `wakeMode`, `payload` sowie fehlerhafte `schedule`). Dies deutet darauf hin, dass mindestens ein Client (wahrscheinlich der Agent-Tool-Call-Pfad) umschlossene oder nur teilweise spezifizierte Job-Payloads sendet. Separat gibt es Abweichungen zwischen Cron-Anbieter-Enums in TypeScript, Gateway-Schema, CLI-Flags und UI-Formulartypen sowie eine UI-Inkonsistenz für `cron.status` (erwartet `jobCount`, während das Gateway `jobs` zurückgibt).

## Ziele

- `cron.add` INVALID_REQUEST-Spam stoppen, indem gängige Wrapper-Payloads normalisiert und fehlende `kind`-Felder abgeleitet werden.
- Cron-Anbieterlisten über Gateway-Schema, Cron-Typen, CLI-Dokumentation und UI-Formulare hinweg ausrichten.
- Das Agent-Cron-Tool-Schema explizit machen, damit das LLM korrekte Job-Payloads erzeugt.
- Die Anzeige der Jobanzahl im Control-UI-Cron-Status korrigieren.
- Tests hinzufügen, um Normalisierung und Tool-Verhalten abzudecken.

## Nicht-Ziele

- Änderung der Cron-Planungssemantik oder des Job-Ausführungsverhaltens.
- Hinzufügen neuer Zeitplantypen oder Cron-Ausdrucks-Parsing.
- Umfassende Überarbeitung der Cron-UI/UX über die notwendigen Feldkorrekturen hinaus.

## Erkenntnisse (aktuelle Lücken)

- `CronPayloadSchema` im Gateway schließt `signal` + `imessage` aus, während TS-Typen diese enthalten.
- Control-UI CronStatus erwartet `jobCount`, das Gateway gibt jedoch `jobs` zurück.
- Das Agent-Cron-Tool-Schema erlaubt beliebige `job`-Objekte und ermöglicht dadurch fehlerhafte Eingaben.
- Das Gateway validiert `cron.add` strikt ohne Normalisierung, sodass umschlossene Payloads fehlschlagen.

## Was sich geändert hat

- `cron.add` und `cron.update` normalisieren nun gängige Wrapper-Formen und leiten fehlende `kind`-Felder ab.
- Das Agent-Cron-Tool-Schema entspricht dem Gateway-Schema, wodurch ungültige Payloads reduziert werden.
- Anbieter-Enums sind über Gateway, CLI, UI und macOS-Picker hinweg ausgerichtet.
- Die Control-UI verwendet das `jobs`-Zählfeld des Gateways für den Status.

## Aktuelles Verhalten

- **Normalisierung:** umschlossene `data`/`job`-Payloads werden entpackt; `schedule.kind` und `payload.kind` werden bei Sicherheit abgeleitet.
- **Standards:** sichere Standardwerte werden für `wakeMode` und `sessionTarget` angewendet, wenn sie fehlen.
- **Anbieter:** Discord/Slack/Signal/iMessage werden nun konsistent über CLI/UI hinweg angezeigt.

Siehe [Cron jobs](/automation/cron-jobs) für die normalisierte Struktur und Beispiele.

## Verifizierung

- Beobachten Sie die Gateway-Logs auf reduzierte `cron.add` INVALID_REQUEST-Fehler.
- Bestätigen Sie, dass der Control-UI-Cron-Status nach dem Aktualisieren die Jobanzahl anzeigt.

## Optionale Nacharbeiten

- Manueller Control-UI-Smoke-Test: pro Anbieter einen Cron-Job hinzufügen und die Jobanzahl im Status verifizieren.

## Offene Fragen

- Sollte `cron.add` explizite `state` von Clients akzeptieren (derzeit durch das Schema untersagt)?
- Sollten wir `webchat` als expliziten Zustellanbieter zulassen (derzeit in der Zustellauflösung gefiltert)?
