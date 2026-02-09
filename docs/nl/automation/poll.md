---
summary: "Poll verzenden via gateway + CLI"
read_when:
  - Toevoegen of wijzigen van poll-ondersteuning
  - Debuggen van pollverzendingen vanuit de CLI of gateway
title: "Polls"
---

# Polls

## Ondersteunde kanalen

- WhatsApp (webkanaal)
- Discord
- MS Teams (Adaptive Cards)

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

Opties:

- `--channel`: `whatsapp` (standaard), `discord` of `msteams`
- `--poll-multi`: meerdere opties selecteren toestaan
- `--poll-duration-hours`: alleen Discord (standaard 24 wanneer weggelaten)

## Gateway RPC

Methode: `poll`

Parameters:

- `to` (string, vereist)
- `question` (string, vereist)
- `options` (string[], vereist)
- `maxSelections` (number, optioneel)
- `durationHours` (number, optioneel)
- `channel` (string, optioneel, standaard: `whatsapp`)
- `idempotencyKey` (string, vereist)

## Kanaalverschillen

- WhatsApp: 2–12 opties, `maxSelections` moet binnen het aantal opties vallen, negeert `durationHours`.
- Discord: 2–10 opties, `durationHours` begrensd op 1–768 uur (standaard 24). `maxSelections > 1` schakelt multi-select in; Discord ondersteunt geen strikt selectietelling.
- MS Teams: Adaptive Card-polls (door OpenClaw beheerd). Geen native poll-API; `durationHours` wordt genegeerd.

## Agent-tool (Message)

Gebruik de `message`-tool met de `poll`-actie (`to`, `pollQuestion`, `pollOption`, optioneel `pollMulti`, `pollDurationHours`, `channel`).

Let op: Discord heeft geen modus “exact N kiezen”; `pollMulti` komt overeen met multi-select.
Teams-polls worden weergegeven als Adaptive Cards en vereisen dat de gateway online blijft
om stemmen vast te leggen in `~/.openclaw/msteams-polls.json`.
