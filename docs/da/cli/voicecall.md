---
summary: "CLI-reference for `openclaw voicecall` (kommandoflade for voice-call-plugin)"
read_when:
  - Du bruger voice-call-pluginet og vil have CLI-indgangspunkterne
  - Du vil have hurtige eksempler på `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# `openclaw voicecall`

`voicecall` er en plugin-leveret kommando. Den vises kun, hvis voice-call-pluginet er installeret og aktiveret.

Primær dokumentation:

- Voice-call-plugin: [Voice Call](/plugins/voice-call)

## Almindelige kommandoer

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Eksponering af webhooks (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Sikkerhedsnote: eksponér kun webhook-endpointet til netværk, du har tillid til. Foretræk Tailscale Serve frem for Funnel, når det er muligt.
