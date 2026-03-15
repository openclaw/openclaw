# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Plugin system: `https://docs.openclaw.ai/plugin`

## Install (local dev)

### Option A: install via OpenClaw (recommended)

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

### Option B: copy into your global extensions folder (dev)

```bash
mkdir -p ~/.openclaw/extensions
cp -R extensions/voice-call ~/.openclaw/extensions/voice-call
cd ~/.openclaw/extensions/voice-call && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",

  twilio: {
    accountSid: "ACxxxxxxxx",
    authToken: "your_token",
  },

  telnyx: {
    apiKey: "KEYxxxx",
    connectionId: "CONNxxxx",
    // Telnyx webhook public key from the Telnyx Mission Control Portal
    // (Base64 string; can also be set via TELNYX_PUBLIC_KEY).
    publicKey: "...",
  },

  plivo: {
    authId: "MAxxxxxxxxxxxxxxxxxxxx",
    authToken: "your_token",
  },

  // Webhook server
  serve: {
    port: 3334,
    path: "/voice/webhook",
  },

  // Public exposure (pick one):
  // publicUrl: "https://example.ngrok.app/voice/webhook",
  // tunnel: { provider: "ngrok" },
  // tailscale: { mode: "funnel", path: "/voice/webhook" }

  outbound: {
    defaultMode: "notify", // or "conversation"
  },

  streaming: {
    enabled: true,
    streamPath: "/voice/stream",
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `messages.tts` configuration (OpenAI or ElevenLabs) for
streaming speech on calls. Override examples and provider caveats live here:
`https://docs.openclaw.ai/plugins/voice-call#tts-for-calls`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Tool

Tool name: `voice_call`

Actions:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?)
- `voicecall.continue` (callId, message)
- `voicecall.speak` (callId, message)
- `voicecall.end` (callId)
- `voicecall.status` (callId)

## Realtime voice mode (OpenAI Realtime API)

Realtime mode routes inbound calls directly to the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) for voice-to-voice conversation (~200–400 ms latency vs ~2–3 s for the STT/TTS pipeline). It is disabled by default and mutually exclusive with `streaming.enabled`.

### Requirements

- `OPENAI_API_KEY` set in your environment (or `streaming.openaiApiKey` in config).
- A **publicly reachable HTTPS endpoint with WebSocket support** — the webhook server must accept both POST requests (Twilio webhook) and WebSocket upgrades (Twilio Media Stream). A plain HTTP tunnel is not sufficient; Twilio requires WSS.
- `inboundPolicy` set to `"open"` or `"allowlist"` (not `"disabled"`) so the plugin accepts inbound calls.

### Config

```json5
{
  inboundPolicy: "open", // required: realtime needs inbound calls enabled

  realtime: {
    enabled: true,
    voice: "alloy", // Realtime API voices: alloy, ash, ballad, cedar, coral,
    //                     echo, marin, sage, shimmer, verse
    instructions: "You are a helpful assistant.",
    model: "gpt-4o-mini-realtime-preview", // optional, this is the default
    temperature: 0.8, // 0–2, optional
    vadThreshold: 0.5, // voice activity detection sensitivity, 0–1, optional
    silenceDurationMs: 500, // ms of silence before end-of-turn, optional
  },
}
```

### Environment variable overrides

All `realtime.*` fields can be set via environment variables (config takes precedence):

| Env var                       | Config field                 |
| ----------------------------- | ---------------------------- |
| `REALTIME_VOICE_ENABLED=true` | `realtime.enabled`           |
| `REALTIME_VOICE_MODEL`        | `realtime.model`             |
| `REALTIME_VOICE_VOICE`        | `realtime.voice`             |
| `REALTIME_VOICE_INSTRUCTIONS` | `realtime.instructions`      |
| `REALTIME_VOICE_TEMPERATURE`  | `realtime.temperature`       |
| `VAD_THRESHOLD`               | `realtime.vadThreshold`      |
| `SILENCE_DURATION_MS`         | `realtime.silenceDurationMs` |

### How it works

1. Twilio sends a POST webhook to `serve.path` (default `/voice/webhook`).
2. The plugin responds with TwiML `<Connect><Stream>` pointing to `wss://<host>/voice/stream/realtime`.
3. Twilio opens a WebSocket to that path carrying the caller's audio in μ-law format.
4. The plugin bridges the WebSocket to the OpenAI Realtime API — audio flows in both directions in real time.
5. The call is registered with CallManager and appears in `openclaw voice status` / `openclaw voice history`.

### Networking notes

- `serve.bind` defaults to `127.0.0.1`. If running inside Docker with an external port mapping, set `serve.bind: "0.0.0.0"` so the container's port is reachable from the host.
- The WebSocket upgrade path (`/voice/stream/realtime`) must be reachable on the same host and port as the webhook. Reverse proxies must pass `Upgrade: websocket` headers through.
- When using Tailscale Funnel on the host (outside Docker), configure Funnel to route `/voice/` to the plugin's local port. The gateway itself does not need to be exposed via Tailscale Funnel.

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Media streaming requires `ws` and OpenAI Realtime API key.
