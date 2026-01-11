---
name: voice-call
description: Start voice calls via the Clawdbot voice-call plugin.
metadata: {"clawdbot":{"emoji":"📞","skillKey":"voice-call","requires":{"config":["plugins.entries.voice-call.enabled"]}}}
---

# Voice Call

Use the voice-call plugin to start or inspect calls.

## CLI

```bash
clawdbot voicecall status
clawdbot voicecall start --to "+15555550123" --message "Hello"
```

## Tool

Use `voice_call` for agent-initiated calls.

Parameters:
- `to` (string): phone number or provider target
- `message` (string, optional): optional intro or instruction
- `mode` ("call" | "status", optional)

Notes:
- Requires the voice-call plugin to be enabled.
- Plugin config lives under `plugins.entries.voice-call.config`.
