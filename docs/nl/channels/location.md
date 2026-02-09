---
summary: "Parseren van inkomende kanaallocaties (Telegram + WhatsApp) en contextvelden"
read_when:
  - Het toevoegen of wijzigen van kanaallocatieparsing
  - Het gebruiken van locatiecontextvelden in agentprompts of tools
title: "Kanaallocatieparsing"
---

# channels/location.md

OpenClaw normaliseert gedeelde locaties uit chatkanalen naar:

- menselijk leesbare tekst die aan de inkomende body wordt toegevoegd, en
- gestructureerde velden in de contextpayload voor automatisch antwoord.

Momenteel ondersteund:

- **Telegram** (locatiepinnen + locaties + live locaties)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` met `geo_uri`)

## Tekst opmaak

Locaties worden weergegeven als vriendelijke regels zonder haakjes:

- Pin:
  - `📍 48.858844, 2.294351 ±12m`
- Benoemde plaats:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Live delen:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Als het kanaal een bijschrift/opmerking bevat, wordt dit op de volgende regel toegevoegd:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Contextvelden

Wanneer een locatie aanwezig is, worden deze velden toegevoegd aan `ctx`:

- `LocationLat` (nummer)
- `LocationLon` (nummer)
- `LocationAccuracy` (nummer, meters; optioneel)
- `LocationName` (string; optioneel)
- `LocationAddress` (string; optioneel)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)

## Kanaalnotities

- **Telegram**: locaties mappen naar `LocationName/LocationAddress`; live locaties gebruiken `live_period`.
- **WhatsApp**: `locationMessage.comment` en `liveLocationMessage.caption` worden als bijschriftregel toegevoegd.
- **Matrix**: `geo_uri` wordt geparseerd als een pinlocatie; hoogte wordt genegeerd en `LocationIsLive` is altijd false.
