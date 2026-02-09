---
summary: "Direktivsyntax für /think + /verbose und wie sie die Modellbegründung beeinflussen"
read_when:
  - Anpassen von Denk- oder Ausführlichkeitsrichtlinien
title: "Denkstufen"
---

# Denkstufen (/think-Direktiven)

## Was es tut

- Inline-Direktive in jedem eingehenden Text: `/t <level>`, `/think:<level>` oder `/thinking <level>`.
- Stufen (Aliasse): `off | minimal | low | medium | high | xhigh` (nur GPT-5.2- und Codex-Modelle)
  - minimal → „think“
  - low → „think hard“
  - medium → „think harder“
  - high → „ultrathink“ (maximales Budget)
  - xhigh → „ultrathink+“ (nur GPT-5.2- und Codex-Modelle)
  - `x-high`, `x_high`, `extra-high`, `extra high` und `extra_high` werden auf `xhigh` abgebildet.
  - `highest`, `max` werden auf `high` abgebildet.
- Anbieterhinweise:
  - Z.AI (`zai/*`) unterstützt nur binäres Denken (`on`/`off`). Jede Nicht-`off`-Stufe wird als `on` behandelt (abgebildet auf `low`).

## Auflösungsreihenfolge

1. Inline-Direktive in der Nachricht (gilt nur für diese Nachricht).
2. Sitzungsüberschreibung (gesetzt durch Senden einer Nur-Direktive-Nachricht).
3. Globaler Standard (`agents.defaults.thinkingDefault` in der Konfiguration).
4. Fallback: low für Modelle mit Begründungsfähigkeit; andernfalls aus.

## Setzen eines Sitzungsstandards

- Senden Sie eine Nachricht, die **nur** die Direktive enthält (Leerzeichen erlaubt), z. B. `/think:medium` oder `/t high`.
- Dies bleibt für die aktuelle Sitzung bestehen (standardmäßig pro Absender); wird durch `/think:off` oder einen Sitzungs-Leerlauf-Reset gelöscht.
- Eine Bestätigungsantwort wird gesendet (`Thinking level set to high.` / `Thinking disabled.`). Ist die Stufe ungültig (z. B. `/thinking big`), wird der Befehl mit einem Hinweis abgelehnt und der Sitzungszustand bleibt unverändert.
- Senden Sie `/think` (oder `/think:`) ohne Argument, um die aktuelle Denkstufe anzuzeigen.

## Anwendung durch Agenten

- **Eingebetteter Pi**: Die aufgelöste Stufe wird an die In-Process-Laufzeit des Pi-Agenten übergeben.

## Verbose-Direktiven (/verbose oder /v)

- Stufen: `on` (minimal) | `full` | `off` (Standard).
- Eine Nur-Direktive-Nachricht schaltet Verbose auf Sitzungsebene um und antwortet mit `Verbose logging enabled.` / `Verbose logging disabled.`; ungültige Stufen geben einen Hinweis zurück, ohne den Zustand zu ändern.
- `/verbose off` speichert eine explizite Sitzungsüberschreibung; löschen Sie diese über die Sitzungs-UI, indem Sie `inherit` wählen.
- Eine Inline-Direktive betrifft nur diese Nachricht; ansonsten gelten Sitzungs-/globale Standards.
- Senden Sie `/verbose` (oder `/verbose:`) ohne Argument, um die aktuelle Verbose-Stufe anzuzeigen.
- Wenn Verbose aktiviert ist, senden Agenten, die strukturierte Werkzeugergebnisse ausgeben (Pi, andere JSON-Agenten), jeden Werkzeugaufruf als eigene Nur-Metadaten-Nachricht zurück, sofern verfügbar mit dem Präfix `<emoji> <tool-name>: <arg>` (Pfad/Befehl). Diese Werkzeugzusammenfassungen werden gesendet, sobald jedes Werkzeug startet (separate Blasen), nicht als Streaming-Deltas.
- Wenn Verbose `full` ist, werden Werkzeugausgaben nach Abschluss ebenfalls weitergeleitet (separate Blase, auf eine sichere Länge gekürzt). Wenn Sie `/verbose on|full|off` umschalten, während ein Lauf noch läuft, berücksichtigen nachfolgende Werkzeugblasen die neue Einstellung.

## Sichtbarkeit der Begründung (/reasoning)

- Stufen: `on|off|stream`.
- Eine Nur-Direktive-Nachricht schaltet um, ob Denkblöcke in Antworten angezeigt werden.
- Wenn aktiviert, wird die Begründung als **separate Nachricht** mit dem Präfix `Reasoning:` gesendet.
- `stream` (nur Telegram): streamt die Begründung während der Generierung der Antwort in die Telegram-Entwurfsblase und sendet anschließend die finale Antwort ohne Begründung.
- Alias: `/reason`.
- Senden Sie `/reasoning` (oder `/reasoning:`) ohne Argument, um die aktuelle Begründungsstufe anzuzeigen.

## Verwandt

- Dokumentation zum Elevated-Modus finden Sie unter [Elevated mode](/tools/elevated).

## Heartbeats

- Der Heartbeat-Probe-Text ist die konfigurierte Heartbeat-Eingabeaufforderung (Standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline-Direktiven in einer Heartbeat-Nachricht gelten wie üblich (vermeiden Sie jedoch, Sitzungsstandards durch Heartbeats zu ändern).
- Die Heartbeat-Zustellung erfolgt standardmäßig nur mit der finalen Nutzlast. Um auch die separate `Reasoning:`-Nachricht (falls verfügbar) zu senden, setzen Sie `agents.defaults.heartbeat.includeReasoning: true` oder pro Agent `agents.list[].heartbeat.includeReasoning: true`.

## Web-Chat-UI

- Der Denkstufen-Selektor im Web-Chat spiegelt beim Laden der Seite die im eingehenden Sitzungsstore/der Konfiguration gespeicherte Sitzungsstufe wider.
- Die Auswahl einer anderen Stufe gilt nur für die nächste Nachricht (`thinkingOnce`); nach dem Senden springt der Selektor wieder auf die gespeicherte Sitzungsstufe zurück.
- Um den Sitzungsstandard zu ändern, senden Sie wie zuvor eine `/think:<level>`-Direktive; der Selektor spiegelt dies nach dem nächsten Neuladen wider.
