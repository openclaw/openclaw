---
summary: "Pagpapadala ng poll sa pamamagitan ng Gateway + CLI"
read_when:
  - Pagdaragdag o pagbabago ng suporta sa poll
  - Pag-debug ng pagpapadala ng poll mula sa CLI o Gateway
title: "Mga Poll"
---

# Mga Poll

## Mga sinusuportahang channel

- WhatsApp (web channel)
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

Mga opsyon:

- `--channel`: `whatsapp` (default), `discord`, o `msteams`
- `--poll-multi`: pahintulutan ang pagpili ng maraming opsyon
- `--poll-duration-hours`: para lang sa Discord (nagde-default sa 24 kapag hindi isinama)

## Gateway RPC

Method: `poll`

Mga parameter:

- `to` (string, kinakailangan)
- `question` (string, kinakailangan)
- `options` (string[], kinakailangan)
- `maxSelections` (number, opsyonal)
- `durationHours` (number, opsyonal)
- `channel` (string, opsyonal, default: `whatsapp`)
- `idempotencyKey` (string, kinakailangan)

## Mga pagkakaiba ng channel

- WhatsApp: 2-12 opsyon, ang `maxSelections` ay dapat nasa loob ng bilang ng opsyon, binabalewala ang `durationHours`.
- Discord: 2-10 options, `durationHours` clamped to 1-768 hours (default 24). `maxSelections > 1` enables multi-select; Discord does not support a strict selection count.
- MS Teams: Adaptive Card polls (OpenClaw-managed). No native poll API; `durationHours` is ignored.

## Agent tool (Message)

Gamitin ang tool na `message` kasama ang aksyong `poll` (`to`, `pollQuestion`, `pollOption`, opsyonal na `pollMulti`, `pollDurationHours`, `channel`).

Tandaan: Walang “pick exactly N” mode ang Discord; ang `pollMulti` ay tumutugma sa multi-select.
Ang mga Teams poll ay nirender bilang Adaptive Cards at nangangailangan na manatiling online ang gateway
upang maitala ang mga boto sa `~/.openclaw/msteams-polls.json`.
