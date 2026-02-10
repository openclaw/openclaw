# @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Official Voice Call plugin for **OpenClaw**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Providers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Twilio** (Programmable Voice + Media Streams)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Telnyx** (Call Control v2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Plivo** (Voice API + XML transfer + GetInput speech)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Mock** (dev/no network)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: `https://docs.openclaw.ai/plugins/voice-call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plugin system: `https://docs.openclaw.ai/plugin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install (local dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option A: install via OpenClaw (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart the Gateway afterwards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option B: copy into your global extensions folder (dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
mkdir -p ~/.openclaw/extensions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cp -R extensions/voice-call ~/.openclaw/extensions/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd ~/.openclaw/extensions/voice-call && pnpm install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Put under `plugins.entries.voice-call.config`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  provider: "twilio", // or "telnyx" | "plivo" | "mock"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  fromNumber: "+15550001234",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  toNumber: "+15550005678",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  twilio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    accountSid: "ACxxxxxxxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    authToken: "your_token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plivo: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    authId: "MAxxxxxxxxxxxxxxxxxxxx",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    authToken: "your_token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Webhook server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  serve: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    port: 3334,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    path: "/voice/webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // Public exposure (pick one):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // publicUrl: "https://example.ngrok.app/voice/webhook",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // tunnel: { provider: "ngrok" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  // tailscale: { mode: "funnel", path: "/voice/webhook" }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  outbound: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaultMode: "notify", // or "conversation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  streaming: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    streamPath: "/voice/stream",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mock` is a local dev provider (no network calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` allows Twilio webhooks with invalid signatures **only** when `tunnel.provider="ngrok"` and `serve.bind` is loopback (ngrok local agent). Use for local dev only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TTS for calls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
streaming speech on calls. You can override it under the plugin config with the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
same shape — overrides deep-merge with `messages.tts`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    provider: "openai",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openai: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      voice: "alloy",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Edge TTS is ignored for voice calls (telephony audio needs PCM; Edge output is unreliable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider native voices.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall continue --call-id <id> --message "Any questions?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall speak --call-id <id> --message "One moment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall end --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall status --call-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall tail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw voicecall expose --mode funnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tool name: `voice_call`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `initiate_call` (message, to?, mode?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `continue_call` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `speak_to_user` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `end_call` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `get_status` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.initiate` (to?, message, mode?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.continue` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.speak` (callId, message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.end` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `voicecall.status` (callId)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses webhook signature verification for Twilio/Telnyx/Plivo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `responseModel` / `responseSystemPrompt` control AI auto-responses.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media streaming requires `ws` and OpenAI Realtime API key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
