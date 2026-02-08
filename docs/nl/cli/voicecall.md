---
summary: "CLI-referentie voor `openclaw voicecall` (opdrachtoppervlak van de voice-call plugin)"
read_when:
  - Je gebruikt de voice-call plugin en wilt de CLI-ingangspunten
  - Je wilt snelle voorbeelden voor `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:13Z
---

# `openclaw voicecall`

`voicecall` is een door een plugin geleverde opdracht. Deze verschijnt alleen als de voice-call plugin is geïnstalleerd en ingeschakeld.

Primaire documentatie:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Veelgebruikte opdrachten

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Webhooks blootstellen (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Beveiligingsopmerking: stel het webhook-eindpunt alleen bloot aan netwerken die je vertrouwt. Geef waar mogelijk de voorkeur aan Tailscale Serve boven Funnel.
