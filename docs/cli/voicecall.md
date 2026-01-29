---
summary: "CLI reference for `dna voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
---

# `dna voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:
- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
dna voicecall status --call-id <id>
dna voicecall call --to "+15555550123" --message "Hello" --mode notify
dna voicecall continue --call-id <id> --message "Any questions?"
dna voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
dna voicecall expose --mode serve
dna voicecall expose --mode funnel
dna voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.

