---
summary: "CLI reference for `smart-agent-neo voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `smart-agent-neo voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
smart-agent-neo voicecall status --call-id <id>
smart-agent-neo voicecall call --to "+15555550123" --message "Hello" --mode notify
smart-agent-neo voicecall continue --call-id <id> --message "Any questions?"
smart-agent-neo voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
smart-agent-neo voicecall expose --mode serve
smart-agent-neo voicecall expose --mode funnel
smart-agent-neo voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
