---
summary: "Parsning av inkommande kanalplatser (Telegram + WhatsApp) och kontextfält"
read_when:
  - Lägga till eller ändra parsning av kanalplatser
  - Använda platskontextfält i agentprompter eller verktyg
title: "Kanalplatsparsning"
---

# Kanalplatsparsning

OpenClaw normaliserar delade platser från chattkanaler till:

- läsbar text som läggs till i den inkommande meddelandetexten, och
- strukturerade fält i kontextnyttolasten för autosvar.

För närvarande stöds:

- **Telegram** (platsnålar + platser + liveplatser)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` med `geo_uri`)

## Textformatering

Platser återges som vänliga rader utan hakparenteser:

- Nål:
  - `📍 48.858844, 2.294351 ±12m`
- Namngiven plats:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Livedelning:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Om kanalen innehåller en bildtext/kommentar läggs den till på nästa rad:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Kontextfält

När en plats finns närvarande läggs dessa fält till i `ctx`:

- `LocationLat` (nummer)
- `LocationLon` (nummer)
- `LocationAccuracy` (nummer, meter; valfritt)
- `LocationName` (sträng; valfritt)
- `LocationAddress` (sträng; valfritt)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolesk)

## Kanalnoteringar

- **Telegram**: platser mappas till `LocationName/LocationAddress`; liveplatser använder `live_period`.
- **WhatsApp**: `locationMessage.comment` och `liveLocationMessage.caption` läggs till som bildtextraden.
- **Matrix**: `geo_uri` tolkas som en nålplats; höjd ignoreras och `LocationIsLive` är alltid false.
