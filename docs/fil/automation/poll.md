---
summary: "Pagpapadala ng poll sa pamamagitan ng Gateway + CLI"
read_when:
  - Pagdaragdag o pagbabago ng suporta sa poll
  - Pag-debug ng pagpapadala ng poll mula sa CLI o Gateway
title: "Mga Poll"
x-i18n:
  source_path: automation/poll.md
  source_hash: 760339865d27ec40
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
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
- Discord: 2-10 opsyon, ang `durationHours` ay kinoklamp sa 1-768 oras (default 24). Pinapagana ng `maxSelections > 1` ang multi-select; hindi sinusuportahan ng Discord ang mahigpit na bilang ng pagpili.
- MS Teams: Mga poll gamit ang Adaptive Card (pinamamahalaan ng OpenClaw). Walang native na poll API; binabalewala ang `durationHours`.

## Agent tool (Message)

Gamitin ang tool na `message` kasama ang aksyong `poll` (`to`, `pollQuestion`, `pollOption`, opsyonal na `pollMulti`, `pollDurationHours`, `channel`).

Tala: Walang mode ang Discord na “pumili ng eksaktong N”; ang `pollMulti` ay nagma-map sa multi-select.
Ang mga poll sa Teams ay nirere-render bilang Adaptive Cards at nangangailangan na manatiling online ang Gateway
para maitala ang mga boto sa `~/.openclaw/msteams-polls.json`.
