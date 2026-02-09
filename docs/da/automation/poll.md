---
summary: "Afsendelse af afstemninger via gateway + CLI"
read_when:
  - Tilføjelse eller ændring af understøttelse af afstemninger
  - Fejlfinding af afstemningsafsendelser fra CLI eller gateway
title: "Afstemninger"
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
- Discord: 2-10 muligheder, `varighedTimer` fastspændt til 1-768 timer (standard 24). `maxSelection > 1` aktiverer multi-select; Discord understøtter ikke en streng markeringstælling.
- MS Teams: Adaptive Card meningsmålinger (OpenClaw-administreret). Ingen native meningsmåling API; `durationHours` ignoreres.

## Agent-værktøj (Message)

Brug værktøjet `message` med handlingen `poll` (`to`, `pollQuestion`, `pollOption`, valgfri `pollMulti`, `pollDurationHours`, `channel`).

Bemærk: Discord har ingen “vælge præcis N” tilstand; `pollMulti` kort til multi-select.
Teams meningsmålinger gengives som Adaptive Cards og kræver gateway til at forblive online
for at registrere stemmer i `~/.openclaw/msteams-polls.json`.
