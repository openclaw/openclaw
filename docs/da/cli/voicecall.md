---
summary: "CLI-reference for `openclaw voicecall` (kommandoflade for voice-call-plugin)"
read_when:
  - Du bruger voice-call-pluginet og vil have CLI-indgangspunkterne
  - Du vil have hurtige eksempler på `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` er en plugin-levereret kommando. Det vises kun, hvis plugin'et til telefonopkald er installeret og aktiveret.

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

Sikkerhedsnote: Udsæt kun webhook endpoint til netværk, du stoler på. Foretræk Tailscale Serveres over Tragt, når det er muligt.
