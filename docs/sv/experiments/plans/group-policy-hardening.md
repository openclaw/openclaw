---
summary: "Härdning av Telegrams tillåtelselista: prefix + normalisering av blanksteg"
read_when:
  - Vid granskning av historiska ändringar i Telegrams tillåtelselista
title: "Härdning av Telegrams tillåtelselista"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:08Z
---

# Härdning av Telegrams tillåtelselista

**Datum**: 2026-01-05  
**Status**: Klar  
**PR**: #216

## Sammanfattning

Telegram‑tillåtelselistor accepterar nu prefixen `telegram:` och `tg:` skiftlägesokänsligt och tolererar
oavsiktliga blanksteg. Detta anpassar inkommande kontroller av tillåtelselistan till normaliseringen vid utgående skick.

## Vad som ändrades

- Prefixen `telegram:` och `tg:` behandlas likadant (skiftlägesokänsligt).
- Poster i tillåtelselistan trimmas; tomma poster ignoreras.

## Exempel

Alla dessa accepteras för samma ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Varför det är viktigt

Kopiera/klistra från loggar eller chatt‑ID:n innehåller ofta prefix och blanksteg. Normalisering undviker
falska negativa resultat när man avgör om man ska svara i DM:er eller grupper.

## Relaterad dokumentation

- [Gruppchattar](/channels/groups)
- [Telegram‑leverantör](/channels/telegram)
