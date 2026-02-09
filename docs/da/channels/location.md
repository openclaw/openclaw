---
summary: "Parsing af indgående kanalers placering (Telegram + WhatsApp) og kontekstfelter"
read_when:
  - Tilføjelse eller ændring af parsing af kanalplacering
  - Brug af kontekstfelter for placering i agentprompter eller værktøjer
title: "Parsing af kanalplacering"
---

# Parsing af kanalplacering

OpenClaw normaliserer delte placeringer fra chatkanaler til:

- menneskeligt læsbar tekst, der føjes til den indgående brødtekst, og
- strukturerede felter i auto-svar-kontekstpayloaden.

Aktuelt understøttet:

- **Telegram** (placeringsnåle + venues + live-placeringer)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` med `geo_uri`)

## Tekstformatering

Placeringer gengives som venlige linjer uden parenteser:

- Nål:
  - `📍 48.858844, 2.294351 ±12m`
- Navngivet sted:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Live-deling:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Hvis kanalen indeholder en billedtekst/kommentar, tilføjes den på næste linje:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Kontekstfelter

Når en placering er til stede, tilføjes disse felter til `ctx`:

- `LocationLat` (tal)
- `LocationLon` (tal)
- `LocationAccuracy` (tal, meter; valgfri)
- `LocationName` (streng; valgfri)
- `LocationAddress` (streng; valgfri)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolesk)

## Kanalnoter

- **Telegram**: venues kortlægges til `LocationName/LocationAddress`; live-placeringer bruger `live_period`.
- **WhatsApp**: `locationMessage.comment` og `liveLocationMessage.caption` tilføjes som billedtekstlinjen.
- **Matrix**: `geo_uri` parses som en nåleplacering; højde ignoreres, og `LocationIsLive` er altid false.
