---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Start voice calls via the OpenClaw voice-call plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📞",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "skillKey": "voice-call",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "config": ["plugins.entries.voice-call.enabled"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Voice Call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the voice-call plugin to start or inspect calls (Twilio, Telnyx, Plivo, or mock).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall status --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `voice_call` for agent-initiated calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `initiate_call` (message, to?, mode?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `continue_call` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `speak_to_user` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `end_call` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `get_status` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires the voice-call plugin to be enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin config lives under `plugins.entries.voice-call.config`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Twilio config: `provider: "twilio"` + `twilio.accountSid/authToken` + `fromNumber`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telnyx config: `provider: "telnyx"` + `telnyx.apiKey/connectionId` + `fromNumber`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plivo config: `provider: "plivo"` + `plivo.authId/authToken` + `fromNumber`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dev fallback: `provider: "mock"` (no network).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
