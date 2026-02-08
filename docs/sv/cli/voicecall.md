---
summary: "CLI-referens för `openclaw voicecall` (kommandoyta för voice-call-pluginen)"
read_when:
  - Du använder voice-call-pluginen och vill ha CLI-ingångarna
  - Du vill ha snabba exempel för `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:49Z
---

# `openclaw voicecall`

`voicecall` är ett plugin-tillhandahållet kommando. Det visas endast om voice-call-pluginen är installerad och aktiverad.

Primär dokumentation:

- Voice-call-plugin: [Voice Call](/plugins/voice-call)

## Vanliga kommandon

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Exponera webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Säkerhetsnotering: exponera endast webhook-slutpunkten för nätverk du litar på. Föredra Tailscale Serve framför Funnel när det är möjligt.
