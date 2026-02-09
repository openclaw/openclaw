---
summary: "Håndtering af tidszoner for agenter, envelopes og prompts"
read_when:
  - Du skal forstå, hvordan tidsstempler normaliseres for modellen
  - Konfigurering af brugerens tidszone til systemprompts
title: "Tidszoner"
---

# Tidszoner

OpenClaw standardiserer tidsstempler, så modellen ser **ét enkelt referencetidspunkt**.

## Message envelopes (lokal som standard)

Indgående beskeder pakkes ind i en envelope som:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Tidsstemplet i envelopen er **som standard værtens lokale tid**, med minutpræcision.

Du kan tilsidesætte dette med:

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

- `envelopeTimezone: "utc"` bruger UTC.
- `envelopeTimezone: "user"` bruger `agents.defaults.userTimezone` (falder tilbage til værtens tidszone).
- Brug en eksplicit IANA tidszone (f.eks. `"Europa/Wien"`) til en fast forskydning.
- `envelopeTimestamp: "off"` fjerner absolutte tidsstempler fra envelope-headere.
- `envelopeElapsed: "off"` fjerner suffikser for forløbet tid (stilen `+2m`).

### Eksempler

**Lokal (standard):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Fast tidszone:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Forløbet tid:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Tool-payloads (rå udbyderdata + normaliserede felter)

Værktøj opkald (`channels.discord.readMessages`, `channels.slack.readMessages`, etc.) returnere **rå udbyderens tidsstempler**.
Vi vedhæfter også normaliserede felter for konsistens:

- `timestampMs` (UTC-epoch-millisekunder)
- `timestampUtc` (ISO 8601 UTC-streng)

Rå felter fra udbyderen bevares.

## Brugerens tidszone i systemprompten

Sæt `agents.defaults.userTimezone` for at fortælle modellen brugerens lokale tidszone. Hvis det er
deaktiveret, løser OpenClaw **værts-tidszonen på runtime** (ingen config skriv).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Systemprompten indeholder:

- afsnittet `Current Date & Time` med lokal tid og tidszone
- `Time format: 12-hour` eller `24-hour`

Du kan styre prompt-formatet med `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Se [Date & Time](/date-time) for den fulde adfærd og eksempler.
