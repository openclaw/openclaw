---
summary: "Telegram-tilladelsesliste-hærdning: præfiks + normalisering af mellemrum"
read_when:
  - Gennemgang af historiske ændringer i Telegram-tilladelseslisten
title: "Telegram-tilladelsesliste-hærdning"
---

# Telegram-tilladelsesliste-hærdning

**Dato**: 2026-01-05  
**Status**: Fuldført  
**PR**: #216

## Resumé

Telegram tillader nu acceptere `telegram:` og `tg:` præfikser case-ufølsomt og tolerere
utilsigtet blanke tegn. Dette justerer indgående tilladsliste kontrol med udgående sende normalisering.

## Hvad er ændret

- Præfikserne `telegram:` og `tg:` behandles ens (uafhængigt af store/små bogstaver).
- Poster i tilladelseslisten trimmes; tomme poster ignoreres.

## Eksempler

Alle disse accepteres for samme ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Hvorfor det er vigtigt

Kopier / indsæt fra logs eller chat IDs indeholder ofte præfikser og mellemrum. Normalisering undgår
falske negativer, når de beslutter, om de skal reagere i DMs eller grupper.

## Relaterede dokumenter

- [Gruppechats](/channels/groups)
- [Telegram-udbyder](/channels/telegram)
