---
summary: "CLI-referens för `openclaw voicecall` (kommandoyta för voice-call-pluginen)"
read_when:
  - Du använder voice-call-pluginen och vill ha CLI-ingångarna
  - Du vill ha snabba exempel för `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` är ett plugin-angivet kommando. Det visas bara om röst-anrop plugin är installerad och aktiverad.

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

Säkerhetsanteckning: exponera endast webhook slutpunkt för nätverk du litar på. Föredra Tailscale Servera över tratt när det är möjligt.
