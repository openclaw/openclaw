---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw voicecall` (voice-call plugin command surface)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You use the voice-call plugin and want the CLI entry points（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want quick examples for `voicecall call|continue|status|tail|expose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "voicecall"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw voicecall`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Primary doc:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice-call plugin: [Voice Call](/plugins/voice-call)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall status --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall continue --call-id <id> --message "Any questions?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall end --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exposing webhooks (Tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall expose --mode serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall expose --mode funnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall unexpose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
