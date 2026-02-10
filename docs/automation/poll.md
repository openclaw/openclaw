---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Poll sending via gateway + CLI"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying poll support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging poll sends from the CLI or gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Polls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Polls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Supported channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp (web channel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams (Adaptive Cards)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# WhatsApp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --target +15555550123 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --target 123456789@g.us \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel discord --target channel:123456789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel discord --target channel:123456789 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# MS Teams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel`: `whatsapp` (default), `discord`, or `msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--poll-multi`: allow selecting multiple options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--poll-duration-hours`: Discord-only (defaults to 24 when omitted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Method: `poll`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Params:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to` (string, required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `question` (string, required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `options` (string[], required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `maxSelections` (number, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `durationHours` (number, optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel` (string, optional, default: `whatsapp`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `idempotencyKey` (string, required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel differences（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: 2-12 options, `maxSelections` must be within option count, ignores `durationHours`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: 2-10 options, `durationHours` clamped to 1-768 hours (default 24). `maxSelections > 1` enables multi-select; Discord does not support a strict selection count.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams: Adaptive Card polls (OpenClaw-managed). No native poll API; `durationHours` is ignored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent tool (Message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the `message` tool with `poll` action (`to`, `pollQuestion`, `pollOption`, optional `pollMulti`, `pollDurationHours`, `channel`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Discord has no “pick exactly N” mode; `pollMulti` maps to multi-select.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Teams polls are rendered as Adaptive Cards and require the gateway to stay online（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to record votes in `~/.openclaw/msteams-polls.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
