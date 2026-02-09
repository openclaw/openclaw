---
summary: "Tijdzone-afhandeling voor agents, enveloppen en prompts"
read_when:
  - Je moet begrijpen hoe tijdstempels voor het model worden genormaliseerd
  - Het configureren van de gebruikers­tijdzone voor systeemprompts
title: "Tijdzones"
---

# Tijdzones

OpenClaw standaardiseert tijdstempels zodat het model **één referentietijd** ziet.

## Bericht-enveloppen (standaard lokaal)

Inkomende berichten worden verpakt in een envelop zoals:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

De tijdstempel in de envelop is **standaard host-lokaal**, met minutenprecisie.

Je kunt dit overschrijven met:

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

- `envelopeTimezone: "utc"` gebruikt UTC.
- `envelopeTimezone: "user"` gebruikt `agents.defaults.userTimezone` (valt terug op de host-tijdzone).
- Gebruik een expliciete IANA-tijdzone (bijv. `"Europe/Vienna"`) voor een vaste offset.
- `envelopeTimestamp: "off"` verwijdert absolute tijdstempels uit envelopheaders.
- `envelopeElapsed: "off"` verwijdert achtervoegsels voor verstreken tijd (de `+2m`-stijl).

### Voorbeelden

**Lokaal (standaard):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Vaste tijdzone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Verstreken tijd:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Tool-payloads (ruwe providerdata + genormaliseerde velden)

Tool-calls (`channels.discord.readMessages`, `channels.slack.readMessages`, enz.) retourneren **ruwe provider-tijdstempels**.
Daarnaast voegen we genormaliseerde velden toe voor consistentie:

- `timestampMs` (UTC-epoch in milliseconden)
- `timestampUtc` (ISO 8601 UTC-tekenreeks)

Ruwe provider-velden blijven behouden.

## Gebruikerstijdzone voor de systeemprompt

Stel `agents.defaults.userTimezone` in om het model de lokale tijdzone van de gebruiker te laten weten. Als dit
niet is ingesteld, bepaalt OpenClaw de **host-tijdzone tijdens runtime** (geen config-wegschrijving).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

De systeemprompt bevat:

- een `Current Date & Time`-sectie met lokale tijd en tijdzone
- `Time format: 12-hour` of `24-hour`

Je kunt het promptformaat bepalen met `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Zie [Datum & Tijd](/date-time) voor het volledige gedrag en voorbeelden.
