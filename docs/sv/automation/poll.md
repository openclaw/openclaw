---
summary: "Skicka omröstningar via gateway + CLI"
read_when:
  - Lägga till eller ändra stöd för omröstningar
  - Felsöka skickade omröstningar från CLI eller gateway
title: "Omröstningar"
---

# Omröstningar

## Stödda kanaler

- WhatsApp (webbkanal)
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

Alternativ:

- `--channel`: `whatsapp` (standard), `discord` eller `msteams`
- `--poll-multi`: tillåter val av flera alternativ
- `--poll-duration-hours`: endast Discord (standard är 24 när den utelämnas)

## Gateway RPC

Metod: `poll`

Parametrar:

- `to` (string, krävs)
- `question` (string, krävs)
- `options` (string[], krävs)
- `maxSelections` (number, valfri)
- `durationHours` (number, valfri)
- `channel` (string, valfri, standard: `whatsapp`)
- `idempotencyKey` (string, krävs)

## Kanalskillnader

- WhatsApp: 2–12 alternativ, `maxSelections` måste ligga inom antalet alternativ, ignorerar `durationHours`.
- Discord: 2-10 alternativ, `durationHours` fastspänd till 1-768 timmar (standard 24). `maxSelections > 1` aktiverar multi-select; Discord stöder inte ett strikt urvalsantal.
- MS Teams: Adaptive Card polls (OpenClaw-managed). Ingen infödd enkät API; `durationHours` ignoreras.

## Agentverktyg (Meddelande)

Använd verktyget `message` med åtgärden `poll` (`to`, `pollQuestion`, `pollOption`, valfri `pollMulti`, `pollDurationHours`, `channel`).

Obs: Discord har inget ”pick exactly N”-läge; `pollMulti`-kartor för multi-select.
Lag omröstningar renderas som Adaptive Cards och kräver att porten stannar online
för att spela in röster i `~/.openclaw/msteams-polls.json`.
