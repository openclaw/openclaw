---
summary: "Datums- und Zeitverarbeitung über Umschläge, Prompts, Werkzeuge und Connectoren hinweg"
read_when:
  - Sie ändern, wie Zeitstempel dem Modell oder den Benutzern angezeigt werden
  - Sie debuggen die Zeitformatierung in Nachrichten oder der Ausgabe des System-Prompts
title: "Datum und Uhrzeit"
---

# Datum & Uhrzeit

OpenClaw verwendet standardmäßig **Host-lokale Zeit für Transport-Zeitstempel** und **die Benutzerzeitzone nur im System-Prompt**.
Anbieter-Zeitstempel bleiben erhalten, sodass Werkzeuge ihre native Semantik beibehalten (die aktuelle Zeit ist über `session_status` verfügbar).

## Nachrichtenumschläge (standardmäßig lokal)

Eingehende Nachrichten werden mit einem Zeitstempel (Minutengenauigkeit) umschlossen:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Dieser Umschlag-Zeitstempel ist **standardmäßig host-lokal**, unabhängig von der Zeitzone des Anbieters.

Sie können dieses Verhalten überschreiben:

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
- `envelopeTimezone: "local"` verwendet die Host-Zeitzone.
- `envelopeTimezone: "user"` verwendet `agents.defaults.userTimezone` (fällt auf die Host-Zeitzone zurück).
- Verwenden Sie eine explizite IANA-Zeitzone (z. B. `"America/Chicago"`) für eine feste Zone.
- `envelopeTimestamp: "off"` entfernt absolute Zeitstempel aus den Umschlag-Headern.
- `envelopeElapsed: "off"` entfernt Suffixe für verstrichene Zeit (der Stil `+2m`).

### Beispiele

**Lokal (Standard):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Benutzerzeitzone:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Verstrichene Zeit aktiviert:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System-Prompt: Aktuelles Datum & Uhrzeit

Wenn die Benutzerzeitzone bekannt ist, enthält der System-Prompt einen dedizierten Abschnitt
**Aktuelles Datum & Uhrzeit** mit **nur der Zeitzone** (keine Uhr-/Zeitformatierung),
um das Prompt-Caching stabil zu halten:

```
Time zone: America/Chicago
```

Wenn der Agent die aktuelle Zeit benötigt, verwenden Sie das Werkzeug `session_status`; die Statuskarte
enthält eine Zeitstempel-Zeile.

## Systemereigniszeilen (standardmäßig lokal)

In die Agenten-Kontext eingefügte, warteschlangenbasierte Systemereignisse werden mit einem Zeitstempel
präfixiert, der dieselbe Zeitzonenauswahl wie Nachrichtenumschläge verwendet (Standard: host-lokal).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Benutzerzeitzone + Format konfigurieren

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` legt die **benutzerlokale Zeitzone** für den Prompt-Kontext fest.
- `timeFormat` steuert die **12h/24h-Anzeige** im Prompt. `auto` folgt den OS-Einstellungen.

## Erkennung des Zeitformats (automatisch)

Wenn `timeFormat: "auto"`, prüft OpenClaw die OS-Einstellung (macOS/Windows)
und fällt auf die Locale-Formatierung zurück. Der erkannte Wert wird **prozessweit zwischengespeichert**,
um wiederholte Systemaufrufe zu vermeiden.

## Werkzeug-Payloads + Connectoren (rohe Anbieterzeit + normalisierte Felder)

Kanal-Werkzeuge geben **anbieter-native Zeitstempel** zurück und fügen zur Konsistenz normalisierte Felder hinzu:

- `timestampMs`: Epoch-Millisekunden (UTC)
- `timestampUtc`: ISO-8601-UTC-String

Rohe Anbieterfelder bleiben erhalten, sodass nichts verloren geht.

- Slack: epoch-ähnliche Strings aus der API
- Discord: UTC-ISO-Zeitstempel
- Telegram/WhatsApp: anbieterspezifische numerische/ISO-Zeitstempel

Wenn Sie lokale Zeit benötigen, konvertieren Sie diese nachgelagert unter Verwendung der bekannten Zeitzone.

## Verwandte Dokumente

- [System Prompt](/concepts/system-prompt)
- [Zeitzonen](/concepts/timezone)
- [Nachrichten](/concepts/messages)
