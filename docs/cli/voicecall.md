---
summary: "CLI reference for `activi voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `activi voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
activi voicecall status --call-id <id>
activi voicecall call --to "+15555550123" --message "Hello" --mode notify
activi voicecall continue --call-id <id> --message "Any questions?"
activi voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
activi voicecall expose --mode serve
activi voicecall expose --mode funnel
activi voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
