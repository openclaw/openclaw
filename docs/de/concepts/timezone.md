---
summary: "Zeitzonenhandhabung für Agenten, Umschläge und Prompts"
read_when:
  - Sie müssen verstehen, wie Zeitstempel für das Modell normalisiert werden
  - Konfiguration der Benutzerzeitzone für System-Prompts
title: "Zeitzonen"
---

# Zeitzonen

OpenClaw standardisiert Zeitstempel, sodass das Modell eine **einheitliche Referenzzeit** sieht.

## Nachrichtenumschläge (standardmäßig lokal)

Eingehende Nachrichten werden in einen Umschlag eingebettet wie:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Der Zeitstempel im Umschlag ist **standardmäßig host-lokal**, mit Minutenpräzision.

Sie können dies überschreiben mit:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` verwendet UTC.
- `envelopeTimezone: "user"` verwendet `agents.defaults.userTimezone` (fällt auf die Host-Zeitzone zurück).
- Verwenden Sie eine explizite IANA-Zeitzone (z. B. `"Europe/Vienna"`) für einen festen Offset.
- `envelopeTimestamp: "off"` entfernt absolute Zeitstempel aus den Umschlag-Headern.
- `envelopeElapsed: "off"` entfernt Suffixe für verstrichene Zeit (der Stil `+2m`).

### Beispiele

**Lokal (Standard):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Feste Zeitzone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Verstrichene Zeit:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Werkzeug-Payloads (rohe Anbieterdaten + normalisierte Felder)

Werkzeugaufrufe (`channels.discord.readMessages`, `channels.slack.readMessages` usw.) geben **rohe Zeitstempel des Anbieters** zurück.
Zusätzlich fügen wir zur Konsistenz normalisierte Felder an:

- `timestampMs` (UTC-Epoch-Millisekunden)
- `timestampUtc` (ISO-8601-UTC-String)

Rohe Anbieterfelder bleiben erhalten.

## Benutzerzeitzone für den System-Prompt

Setzen Sie `agents.defaults.userTimezone`, um dem Modell die lokale Zeitzone des Benutzers mitzuteilen. Ist sie
nicht gesetzt, ermittelt OpenClaw die **Host-Zeitzone zur Laufzeit** (keine Konfigurationsschreiboperation).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Der System-Prompt enthält:

- Abschnitt `Current Date & Time` mit lokaler Zeit und Zeitzone
- `Time format: 12-hour` oder `24-hour`

Sie können das Prompt-Format mit `agents.defaults.timeFormat` steuern (`auto` | `12` | `24`).

Siehe [Date & Time](/date-time) für das vollständige Verhalten und Beispiele.
