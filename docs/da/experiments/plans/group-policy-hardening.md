---
summary: "Telegram-tilladelsesliste-hærdning: præfiks + normalisering af mellemrum"
read_when:
  - Gennemgang af historiske ændringer i Telegram-tilladelseslisten
title: "Telegram-tilladelsesliste-hærdning"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:10Z
---

# Telegram-tilladelsesliste-hærdning

**Dato**: 2026-01-05  
**Status**: Fuldført  
**PR**: #216

## Resumé

Telegram-tilladelseslister accepterer nu `telegram:`- og `tg:`-præfikser uafhængigt af store/små bogstaver og tolererer
utilsigtede mellemrum. Dette afstemmer indgående tilladelseslistekontroller med normalisering ved udgående afsendelse.

## Hvad er ændret

- Præfikserne `telegram:` og `tg:` behandles ens (uafhængigt af store/små bogstaver).
- Poster i tilladelseslisten trimmes; tomme poster ignoreres.

## Eksempler

Alle disse accepteres for samme ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Hvorfor det er vigtigt

Kopi/indsæt fra logs eller chat-id’er indeholder ofte præfikser og mellemrum. Normalisering undgår
falske negative, når der besluttes, om der skal svares i DM’er eller grupper.

## Relaterede dokumenter

- [Gruppechats](/channels/groups)
- [Telegram-udbyder](/channels/telegram)
