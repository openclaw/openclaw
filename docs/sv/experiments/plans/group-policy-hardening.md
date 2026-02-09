---
summary: "Härdning av Telegrams tillåtelselista: prefix + normalisering av blanksteg"
read_when:
  - Vid granskning av historiska ändringar i Telegrams tillåtelselista
title: "Härdning av Telegrams tillåtelselista"
---

# Härdning av Telegrams tillåtelselista

**Datum**: 2026-01-05  
**Status**: Klar  
**PR**: #216

## Sammanfattning

Telegram allowlists accepterar nu `telegram:` och `tg:` prefixar skiftläge-okänsligt och tolererar
oavsiktligt blanktecken. Detta anpassar inkommande tillåtna kontroller med utgående skicka normalisering.

## Vad som ändrades

- Prefixen `telegram:` och `tg:` behandlas likadant (skiftlägesokänsligt).
- Poster i tillåtelselistan trimmas; tomma poster ignoreras.

## Exempel

Alla dessa accepteras för samma ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Varför det är viktigt

Kopiera/klistra in från loggar eller chatt-ID innehåller ofta prefix och blanktecken. Normalisering undviker
falska negativ när man beslutar om man ska svara i DMs eller grupper.

## Relaterad dokumentation

- [Gruppchattar](/channels/groups)
- [Telegram‑leverantör](/channels/telegram)
