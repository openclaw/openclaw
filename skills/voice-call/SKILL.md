---
name: voice-call
description: Start voice calls via the Clawdbot voice-call plugin.
metadata: {"clawdbot":{"emoji":"📞","skillKey":"voice-call","requires":{"config":["plugins.entries.voice-call.enabled"]}}}
---

# Voice Call

Use the voice-call plugin to start or inspect calls (Twilio or log fallback).

## CLI

```bash
clawdbot voicecall start --to "+15555550123" --message "Hello from Clawdbot"
clawdbot voicecall status --sid CAxxxxxxxx
```

## Tool

Use `voice_call` for agent-initiated calls.

Parameters:
- `mode` ("call" | "status", optional, default call)
- `to` (string): phone number / target (required for call)
- `sid` (string): call SID (required for status)
- `message` (string, optional): optional intro or instruction

Notes:
- Requires the voice-call plugin to be enabled.
- Plugin config lives under `plugins.entries.voice-call.config`.
- Twilio config: `provider: "twilio"` + `twilio.accountSid/authToken/from` (statusCallbackUrl/twimlUrl optional).
- Dev fallback: `provider: "log"` (no network).
