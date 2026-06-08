# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
- **Microsoft Teams** (`msteams`) — bridges Teams calls via an external Windows worker over an HMAC-authenticated WebSocket (inbound + outbound, with vision + group-call gating). See [Microsoft Teams provider](#microsoft-teams-provider-msteams).
- **Mock** (dev/no network)

Docs: `https://docs.openclaw.ai/plugins/voice-call`
Plugin system: `https://docs.openclaw.ai/tools/plugin`

## Install

```bash
openclaw plugins install @openclaw/voice-call
```

Restart the Gateway afterwards.

## Local dev install

```bash
PLUGIN_HOME=~/.openclaw/extensions
mkdir -p "$PLUGIN_HOME"
cp -R <local-plugin-checkout> "$PLUGIN_HOME/voice-call"
cd "$PLUGIN_HOME/voice-call" && pnpm install
```

## Config

Put under `plugins.entries.voice-call.config`:

```json5
{
  provider: "twilio", // or "telnyx" | "plivo" | "msteams" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",
  sessionScope: "per-phone", // or "per-call"

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

  // Optional response agent workspace. Defaults to "main".
  agentId: "main",

  streaming: {
    enabled: true,
    // optional; if omitted, Voice Call picks the first registered
    // realtime-transcription provider by autoSelectOrder
    provider: "<realtime-transcription-provider-id>",
    streamPath: "/voice/stream",
    providers: {
      "<realtime-transcription-provider-id>": {
        // provider-owned options
      },
    },
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  },
}
```

## Microsoft Teams provider (`msteams`)

Teams calls do not arrive on the webhook/media-stream plane. An **external Windows worker** (not part of this repo) owns the Graph Calling notification endpoint and the `Microsoft.Skype.Bots.Media` AudioSocket; when a call is answered it opens a **per-call WebSocket** to OpenClaw and relays PCM 16 kHz audio in both directions, plus sampled `video.frame`s (caller camera / screen-share) and the live `participants` count.

Supports **inbound and outbound** calls:

- **Inbound** — a caller dials the bot.
- **Outbound (call me back)** — `initiateCall` asks the worker to place a Teams call (e.g. `openclaw_agent_task deliverVia:"call"` so a background job calls the caller back with its result). Configured under `msteams.outbound`.

Capabilities:

- **Vision** — the agent can "see" the caller's camera / shared screen: `look_at_screen` (realtime), automatic frame attachment (streaming), and a realtime ambient frame push so the model is continuously visually aware. Recording-gated; in meetings each frame is attributed to the participant it came from. The per-call spend cap `msteams.maxVisionPerMinute` (default 30, 0 = unlimited) bounds all three across the minute.
- **Expression cues** — the assistant's reply is mapped to a coarse emotion (`neutral`/`happy`/`sad`/`surprised`) and sent to the avatar worker so the rendered face smiles/frowns/reacts. Cheap lexical inference, best-effort, on both streaming (before TTS) and realtime (on the assistant transcript, cued early and self-correcting).
- **Group/meeting gate** — in a group call (2+ humans) the assistant stays silent until addressed by name (`msteams.groupCall.wakePhrases`), mirroring the chat @mention gate; 1:1 calls respond to everything. Deterministic on streaming; instruction-based on realtime.

Two modes:

- **Agent (streaming):** caller audio -> realtime transcription (STT) -> the OpenClaw agent (`responseModel`, with tools) -> TTS. Use this to have the agent _do work_. Requires `streaming.enabled: true`.
- **Realtime (speech-to-speech):** caller audio is bridged directly to a realtime voice provider (e.g. OpenAI Realtime). Lowest latency, conversational. Requires `realtime.enabled: true` + a realtime voice provider. The model handles small talk itself and **delegates real work to the OpenClaw agent**: `openclaw_agent_consult` for quick in-line answers, and (under `realtime.toolPolicy: "owner"`) `openclaw_agent_task` to run a long job in the background and deliver the result to the caller's Teams chat — see [Realtime delegation](#realtime-delegation-consult--background-tasks).

At least one of `streaming.enabled` / `realtime.enabled` must be set (validated), and `msteams.port` + `msteams.sharedSecret` are required.

When `inboundPolicy` is unset, msteams defaults to a **safe `"allowlist"`** (never `"open"`): with an empty `allowFrom` no caller is accepted until you opt callers in or set `inboundPolicy: "open"` explicitly. For `inboundPolicy: "allowlist"`, Teams callers have no phone number, so `allowFrom` entries are matched against the caller's **AAD object id** (a GUID) — list the caller's `aadId` (carrier providers still use E.164 numbers; either form is accepted).

```json5
{
  provider: "msteams",
  inboundPolicy: "allowlist", // safe default; accept only listed callers
  allowFrom: ["00000000-0000-0000-0000-000000000000"], // caller AAD object ids (use "open" to accept any authenticated Teams caller)
  responseModel: "microsoft-foundry/gpt-5.4", // agent model for the streaming path

  msteams: {
    port: 8443,
    bindAddress: "127.0.0.1", // loopback by default; set a trusted-network IP only if the worker is remote
    path: "/voice/msteams/stream",
    sharedSecret: "${MSTEAMS_WS_SECRET}", // SecretRef-compatible; must match the worker
    requireRecordingStatus: true, // see "Recording status" below
  },

  // Agent (streaming) mode:
  streaming: {
    enabled: true,
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        modelId: "scribe_v2_realtime",
        audioFormat: "pcm_16000",
        sampleRate: 16000,
        commitStrategy: "vad",
      },
    },
  },
  tts: { provider: "elevenlabs", providers: { elevenlabs: { voiceId: "..." } } },

  // OR realtime mode (instead of streaming):
  // realtime: { enabled: true, provider: "openai" },
}
```

**Security / transport**

- Every WS upgrade is authenticated with **HMAC-SHA256** over `timestamp.callId` (headers `x-openclawteamsbridge-timestamp` / `x-openclawteamsbridge-signature`), compared in constant time, with a replay window.
- The server **binds loopback (`127.0.0.1`) by default** - set `bindAddress` to a specific trusted-network address only when the worker connects from another host.
- Connection guardrails: total + per-IP connection caps, a pre-start idle timeout, and a 64 KB inbound frame cap.
- `sharedSecret` is SecretRef-compatible (`${ENV}` / secret refs) and never logged.

**Recording status (Microsoft Media Access API)**

Microsoft requires that media or media-derived data not be persisted before the bot has called Graph `updateRecordingStatus`. The worker reports this over the bridge (`recordingStatus` on `session.start`, and the `recording.status` message when it changes). With `requireRecordingStatus: true` (default):

- the **streaming** path **drops transcripts until recording status is active**;
- the **realtime** path **refuses `openclaw_agent_consult` and `openclaw_agent_task` until recording status is active** (the live small-talk conversation continues, but the agent will not process/persist or deliver call audio yet).

VAD is handled by the STT provider (`commitStrategy: "vad"`) on the streaming path and by the realtime model on the realtime path; barge-in is supported on both.

**Realtime delegation (consult + background tasks)**

In realtime mode the speech-to-speech model is given two tools so it can do real work instead of only chatting:

- `openclaw_agent_consult` — runs the OpenClaw agent (with the tools allowed by `realtime.toolPolicy`) and returns a short, speakable result in-line. A "working on it" filler covers longer runs. Use for quick questions/lookups/actions answered on the call.
- `openclaw_agent_task` — available only under `realtime.toolPolicy: "owner"` (the agent's `message` tool, used for delivery, requires owner). The model acks immediately ("I'll message you on Microsoft Teams"), the call is free to continue or hang up, and the OpenClaw agent runs the job in the background, then delivers the final result to the caller's Teams chat via the `message` tool (`channel: "msteams"`, `target: "user:<aadId>"`). Use for multi-step or long-running work.

Both tools are gated by recording status (see above) and respect `inboundPolicy` / `allowFrom`. Tuning: `realtime.consultThinkingLevel`, `realtime.consultFastMode`, `realtime.fastContext`, and `realtime.suppressInputDuringPlayback` (self-echo guard, off by default — Teams sends remote-participant audio, so gating would also defeat barge-in).

**WebSocket protocol** (worker -> OpenClaw): `session.start` (`callId`, `threadId`, `caller.{aadId,displayName,tenantId}`, `recordingStatus?`), `recording.status` (`status`), `audio.frame` (`seq`, `timestampMs`, `payloadBase64` = PCM 16 kHz 16-bit mono), `session.end` (`reason`), `ping` (`ts`). OpenClaw -> worker: `audio.frame` (TTS / realtime audio) and `assistant.cancel` (barge-in).

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- If older configs still use `provider: "log"`, `twilio.from`, or legacy `streaming.*` OpenAI keys, run `openclaw doctor --fix` to rewrite them.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`
- `responseModel` is optional. When unset, voice responses use the runtime default model.
- `sessionScope` defaults to `per-phone`, preserving caller memory across calls. Use `per-call` for reception, booking, IVR, and bridge flows where each carrier call should start fresh.
- `realtime.consultThinkingLevel` is optional. When set, it overrides the thinking level used by the model behind realtime `openclaw_agent_consult` calls.
- `realtime.consultFastMode` is optional. When set, it toggles fast mode for realtime `openclaw_agent_consult` calls.

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `messages.tts` configuration for
streaming speech on calls. Override examples and provider caveats live here:
`https://docs.openclaw.ai/plugins/voice-call#tts-for-calls`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --json
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

## Notes

- Uses webhook signature verification for Twilio/Telnyx/Plivo.
- Adds replay protection for Twilio and Plivo webhooks (valid duplicate callbacks are ignored safely).
- Twilio speech turns include a per-turn token so stale/replayed callbacks cannot complete a newer turn.
- `responseModel` / `responseSystemPrompt` control AI auto-responses.
- Voice-call auto-responses enforce a spoken JSON contract (`{"spoken":"..."}`) and filter reasoning/meta output before playback.
- While a Twilio stream is active, playback does not fall back to TwiML `<Say>`; stream-TTS failures fail the playback request.
- Outbound conversation calls suppress barge-in only while the initial greeting is actively speaking, then re-enable normal interruption.
- Twilio stream disconnect auto-end uses a short grace window so quick reconnects do not end the call.
- Realtime provider selection is generic. Configure `streaming.provider` / `realtime.provider` and put provider-owned options under `providers.<id>`.
- Runtime fallback still accepts the old voice-call keys for now, but migration is a doctor step and the compat shim is scheduled to go away in a future release.
