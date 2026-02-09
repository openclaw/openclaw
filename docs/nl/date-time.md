---
summary: "Datum- en tijdafhandeling over enveloppen, prompts, tools en connectors"
read_when:
  - Je wijzigt hoe tijdstempels aan het model of gebruikers worden getoond
  - Je debugt tijdopmaak in berichten of uitvoer van de systeemprompt
title: "Datum en tijd"
---

# Datum & Tijd

OpenClaw gebruikt standaard **host-lokale tijd voor transporttijdstempels** en **de tijdzone van de gebruiker alleen in de systeemprompt**.
Provider-tijdstempels blijven behouden zodat tools hun native semantiek behouden (de huidige tijd is beschikbaar via `session_status`).

## Bericht-enveloppen (standaard lokaal)

Inkomende berichten worden verpakt met een tijdstempel (nauwkeurigheid tot op de minuut):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Deze enveloptijdstempel is **standaard host-lokaal**, ongeacht de tijdzone van de provider.

Je kunt dit gedrag overschrijven:

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
- `envelopeTimezone: "local"` gebruikt de host-tijdzone.
- `envelopeTimezone: "user"` gebruikt `agents.defaults.userTimezone` (valt terug op de host-tijdzone).
- Gebruik een expliciete IANA-tijdzone (bijv. `"America/Chicago"`) voor een vaste zone.
- `envelopeTimestamp: "off"` verwijdert absolute tijdstempels uit envelopkoppen.
- `envelopeElapsed: "off"` verwijdert suffixen met verstreken tijd (de `+2m`-stijl).

### Voorbeelden

**Lokaal (standaard):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Tijdzone van de gebruiker:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Verstreken tijd ingeschakeld:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## Systeemprompt: Huidige datum & tijd

Als de tijdzone van de gebruiker bekend is, bevat de systeemprompt een aparte sectie
**Huidige datum & tijd** met **alleen de tijdzone** (geen klok-/tijdopmaak)
om prompt-caching stabiel te houden:

```
Time zone: America/Chicago
```

Wanneer de agent de huidige tijd nodig heeft, gebruik de `session_status`-tool; de statuskaart
bevat een regel met een tijdstempel.

## Systeemevenementregels (standaard lokaal)

In de agentcontext ingevoegde systeemevenementen in de wachtrij krijgen een tijdstempel met
dezelfde tijdzoneselectie als bericht-enveloppen (standaard: host-lokaal).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Tijdzone + formaat van de gebruiker configureren

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

- `userTimezone` stelt de **gebruikers-lokale tijdzone** in voor de promptcontext.
- `timeFormat` regelt **12u/24u-weergave** in de prompt. `auto` volgt OS-voorkeuren.

## Tijdformaatdetectie (auto)

Wanneer `timeFormat: "auto"`, inspecteert OpenClaw de OS-voorkeur (macOS/Windows)
en valt terug op locale opmaak. De gedetecteerde waarde wordt **per proces gecachet**
om herhaalde systeemaanroepen te vermijden.

## Tool-payloads + connectors (ruwe provider-tijd + genormaliseerde velden)

Kanaaltools retourneren **provider-natieve tijdstempels** en voegen genormaliseerde velden toe voor consistentie:

- `timestampMs`: epoch milliseconden (UTC)
- `timestampUtc`: ISO 8601 UTC-tekenreeks

Ruwe providervelden blijven behouden zodat er niets verloren gaat.

- Slack: epoch-achtige tekenreeksen uit de API
- Discord: UTC ISO-tijdstempels
- Telegram/WhatsApp: provider-specifieke numerieke/ISO-tijdstempels

Als je lokale tijd nodig hebt, converteer deze downstream met behulp van de bekende tijdzone.

## Gerelateerde documentatie

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
