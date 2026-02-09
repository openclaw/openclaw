---
summary: "Hantering av tidszoner för agenter, kuvert och prompter"
read_when:
  - Du behöver förstå hur tidsstämplar normaliseras för modellen
  - Konfigurering av användarens tidszon för systemprompter
title: "Tidszoner"
---

# Tidszoner

OpenClaw standardiserar tidsstämplar så att modellen ser **en enda referenstid**.

## Meddelandekuvert (lokalt som standard)

Inkommande meddelanden omsluts av ett kuvert som:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Tidsstämpeln i kuvertet är **värd-lokal som standard**, med minutprecision.

Du kan åsidosätta detta med:

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

- `envelopeTimezone: "utc"` använder UTC.
- `envelopeTimezone: "user"` använder `agents.defaults.userTimezone` (faller tillbaka till värdens tidszon).
- Använd en explicit IANA tidszon (t.ex., `"Europa/Wien"`) för en fast offset.
- `envelopeTimestamp: "off"` tar bort absoluta tidsstämplar från kuverthuvuden.
- `envelopeElapsed: "off"` tar bort suffix för förfluten tid (stilen `+2m`).

### Exempel

**Lokalt (standard):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fast tidszon:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Förfluten tid:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Verktygspayloads (rå leverantörsdata + normaliserade fält)

Verktygsanrop (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) returnera **rå leverantörens tidsstämplar**.
Vi bifogar också normaliserade fält för konsekvens:

- `timestampMs` (UTC-epok i millisekunder)
- `timestampUtc` (ISO 8601 UTC-sträng)

Råa leverantörsfält bevaras.

## Användarens tidszon för systemprompten

Ange `agents.defaults.userTimezone` för att berätta för modellen användarens lokala tidszon. Om det är
unset, löser OpenClaw **värdtidszonen vid körning** (ingen config write).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Systemprompten inkluderar:

- avsnittet `Current Date & Time` med lokal tid och tidszon
- `Time format: 12-hour` eller `24-hour`

Du kan styra promptformatet med `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Se [Date & Time](/date-time) för fullständigt beteende och exempel.
