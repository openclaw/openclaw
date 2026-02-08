---
summary: "Sanggunian ng CLI para sa `openclaw voicecall` (command surface ng voice-call plugin)"
read_when:
  - Ginagamit mo ang voice-call plugin at gusto mo ang mga entry point ng CLI
  - Gusto mo ng mga mabilis na halimbawa para sa `voicecall call|continue|status|tail|expose`
title: "voicecall"
x-i18n:
  source_path: cli/voicecall.md
  source_hash: d93aaee6f6f5c9ac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:14Z
---

# `openclaw voicecall`

`voicecall` ay isang command na ibinibigay ng plugin. Lalabas lamang ito kung naka-install at naka-enable ang voice-call plugin.

Pangunahing doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Mga karaniwang command

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Pag-expose ng mga webhook (Tailscale)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Tala sa seguridad: i-expose lamang ang webhook endpoint sa mga network na pinagkakatiwalaan mo. Mas piliin ang Tailscale Serve kaysa Funnel kung maaari.
