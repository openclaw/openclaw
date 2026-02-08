---
summary: "Afsendelse af afstemninger via gateway + CLI"
read_when:
  - Tilføjelse eller ændring af understøttelse af afstemninger
  - Fejlfinding af afstemningsafsendelser fra CLI eller gateway
title: "Afstemninger"
x-i18n:
  source_path: automation/poll.md
  source_hash: 760339865d27ec40
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:51Z
---

# Afstemninger

## Understøttede kanaler

- WhatsApp (webkanal)
- Discord
- Microsoft Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Valgmuligheder:

- `--channel`: `whatsapp` (standard), `discord` eller `msteams`
- `--poll-multi`: tillad valg af flere muligheder
- `--poll-duration-hours`: kun Discord (standard er 24, når den udelades)

## Gateway RPC

Metode: `poll`

Parametre:

- `to` (string, påkrævet)
- `question` (string, påkrævet)
- `options` (string[], påkrævet)
- `maxSelections` (number, valgfri)
- `durationHours` (number, valgfri)
- `channel` (string, valgfri, standard: `whatsapp`)
- `idempotencyKey` (string, påkrævet)

## Kanal-forskelle

- WhatsApp: 2-12 muligheder, `maxSelections` skal være inden for antallet af muligheder, ignorerer `durationHours`.
- Discord: 2-10 muligheder, `durationHours` begrænses til 1-768 timer (standard 24). `maxSelections > 1` aktiverer multivalg; Discord understøtter ikke et strengt valgantal.
- Microsoft Teams: Adaptive Card-afstemninger (OpenClaw-administrerede). Ingen indbygget afstemnings-API; `durationHours` ignoreres.

## Agent-værktøj (Message)

Brug værktøjet `message` med handlingen `poll` (`to`, `pollQuestion`, `pollOption`, valgfri `pollMulti`, `pollDurationHours`, `channel`).

Bemærk: Discord har ingen “vælg præcis N”-tilstand; `pollMulti` kortlægges til multivalg.
Teams-afstemninger gengives som Adaptive Cards og kræver, at gatewayen forbliver online
for at registrere stemmer i `~/.openclaw/msteams-polls.json`.
