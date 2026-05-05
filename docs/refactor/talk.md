---
summary: "Grand unification plan for Talk mode, realtime voice, voice-call, Google Meet, and VoiceClaw realtime"
read_when:
  - Refactoring Talk mode, realtime voice, voice-call, Google Meet, or VoiceClaw realtime
  - Changing Talk protocol, provider contracts, browser realtime, or native voice behavior
  - Deciding whether a voice feature belongs in core, a provider plugin, or a surface adapter
title: "Talk unification plan"
---

# Talk Unification Plan

OpenClaw has several voice loops that grew from different product surfaces: native Talk mode, browser realtime Talk, Voice Call realtime, Google Meet realtime, streaming STT, TTS reply playback, and `/voiceclaw/realtime`. The goal is not to force all of them into one implementation. The goal is one session contract, one event vocabulary, one policy boundary, and small adapters for each surface.

Core should know conversation modes, byte transports, audio formats, tool policy, and client capabilities. Core should not know platform product names such as iOS, Android, or macOS except as optional telemetry emitted by an edge client.

## Goals

- Make browser Talk, native Talk, telephony, meetings, and VoiceClaw realtime share the same session semantics.
- Keep provider-specific realtime behavior in provider plugins.
- Keep telephony and meeting quirks in their owning plugins.
- Move browser realtime agent consult out of browser-owned `chat.send`.
- Keep existing public entry points only as migration adapters while the runtime converges.
- Keep local STT/TTS as a first-class fallback, not a deprecated path.
- Support a first-party walkie-talkie client that can hand off an existing OpenClaw session into voice without becoming a separate assistant.
- Make event logs, latency, usage, tool calls, cancellation, and interruption observable in the same shape everywhere.

## Non Goals

- Do not make core branch on app platforms.
- Do not move OpenAI, Google, Twilio, or meeting-specific behavior into core.
- Do not merge one-shot inbound audio attachments with live Talk sessions beyond sharing STT provider contracts where useful.
- Do not remove `/voiceclaw/realtime` or existing Talk RPC entry points during the first migration; they may reject retired fields instead of preserving every old request shape.
- Do not allow request-time instruction overrides for realtime sessions.
- Do not copy VoiceClaw names or request fields into shared APIs; preserve the realtime runtime capabilities through the shared Talk contract, except request-time instruction overrides.

## Current Surfaces

| Surface                  | Current shape                                                                                                                                         | Keep                                                              | Refactor target                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser Talk             | `talk.realtime.session` returns WebRTC, provider WebSocket, or Gateway relay. Tool calls go through `talk.realtime.toolCall`.                         | Browser audio capture/playback and WebRTC data-channel handling.  | Keep browser media ownership while Gateway owns realtime tool policy.                                   |
| Native Talk              | Local STT, Gateway `chat.send`, response event or `chat.history` polling, then local or Gateway TTS.                                                  | Local STT/TTS fallback and native audio controls.                 | Event-driven success path with shared Talk events.                                                      |
| Voice Call realtime      | Telephony WebSocket with G.711 u-law, marks, interruption, and realtime voice bridge.                                                                 | Telephony adapter ownership.                                      | Adapter over shared Talk session contract.                                                              |
| Voice Call streaming STT | Telephony stream through realtime transcription provider, then TTS playback.                                                                          | STT/TTS pipeline mode.                                            | Explicit `stt-tts` mode adapter.                                                                        |
| Google Meet realtime     | Meeting participant context, echo suppression, realtime provider bridge, fast context.                                                                | Meeting adapter ownership.                                        | Adapter over shared Talk session contract and metrics.                                                  |
| VoiceClaw realtime       | Separate WebSocket endpoint with Gemini Live, direct tools, audio/video frames, interruption, cancellation, session rotation/resumption, and metrics. | Migration endpoint; realtime runtime primitives except overrides. | Shared Talk contract; server-owned instructions; no request-time override.                              |
| TTS                      | `talk.speak` and provider TTS config.                                                                                                                 | Speech provider abstraction.                                      | Cleanly separated from realtime provider config.                                                        |
| STT                      | Batch audio and streaming transcription providers.                                                                                                    | Provider contracts.                                               | Streaming STT is an input strategy for `stt-tts`; batch voice notes stay outside live Talk.             |
| Walkie-talkie handoff    | Prototype pattern: existing session, phone capture, push-to-talk turn, STT, agent turn, TTS playback, and transcript mirror.                          | One-button voice handoff UX and long-form PTT.                    | Gateway-backed handoff room using shared Talk events, provider catalogs, and existing session delivery. |

## Core Model

Separate the dimensions. Mode is how the conversation runs. Transport is how bytes move. Brain is who handles tools and agent reasoning. Surface is edge-owned and should not drive core branching.

```ts
type TalkMode = "realtime" | "stt-tts" | "transcription";

type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";

type TalkBrain = "agent-consult" | "direct-tools" | "none";
```

### Modes

`realtime` is a provider-native live session. Audio goes in, audio comes out, interruptions and tool calls happen inside one low-latency session. OpenAI Realtime and Google Live fit here. WebRTC and provider WebSockets are transports for this mode, not separate modes.

`stt-tts` is the classic pipeline: speech-to-text, agent text turn, text-to-speech. It is higher latency, but it works with local native speech, streaming STT providers, low-cost fallback providers, offline-ish native paths, and providers that do not support realtime voice.

`transcription` is speech-to-text without an assistant speech response. It covers dictation, captions, meeting transcript capture, and voice-note style ingestion when the live session layer is useful. Gateway-owned transcription relay sessions use `talk.transcription.session`, `talk.transcription.relayAudio`, `talk.transcription.relayCancel`, and `talk.transcription.relayStop`. One-shot batch audio attachments can still use the existing media path without becoming Talk sessions.

### Transports

`webrtc` is browser or WebRTC-capable client transport using SDP and media/data channels. It is the best fit for direct OpenAI Realtime browser sessions with ephemeral credentials.

`provider-websocket` is a constrained provider WebSocket carrying JSON control messages and PCM audio. It fits Google Live-style browser or server streams where WebRTC is not the provider contract.

`gateway-relay` keeps the vendor session on the Gateway. Clients send authenticated audio frames to Gateway and receive audio/events back. This is the secure default for providers without browser-safe tokens and for server-owned tool policy.

`managed-room` is a Gateway-owned room/session where one or more clients join a managed Talk handoff. It is the primitive for first-party walkie-talkie clients: Gateway owns rendezvous, expiry, replacement, turn lifecycle events, and provider credentials while the edge client owns capture and playback.

Telephony, meetings, and native apps are not core transports. They are surface adapters that choose one of the transports above or implement local `stt-tts` before handing text/audio events into the shared session contract.

Canonical transport names are the names above. Legacy browser-session transport names should be normalized at adapter boundaries (`webrtc-sdp` to `webrtc`, `json-pcm-websocket` to `provider-websocket`) so mixed-version clients and external providers keep working. Do not keep the legacy names as a second internal vocabulary. When a versioned creation RPC exists, freeze the old RPC shape and delete the aliases only after the announced compatibility window.

### Brain Strategies

`agent-consult` means the realtime model asks Gateway to consult an OpenClaw agent. Gateway applies tool policy, chooses fork or isolated context, runs the agent, and returns a concise result to the realtime provider.

`direct-tools` means the realtime provider receives a direct OpenClaw tool declaration and calls Gateway-owned tools. This is the VoiceClaw-style brain and should require owner-level authorization.

`none` means the session is pure transcription, external orchestration, or client-managed speech without OpenClaw tool access.

## Shared Talk Session Runtime

The next cleanup layer is a shared Talk session controller. It should be the only code that owns event sequencing, active turn state, capture state, output audio state, recent event retention, and stale-turn rejection. Surface adapters may decide when to call it, but they should not each reimplement turn bookkeeping.

The controller contract should cover:

- `emit(...)` for session, health, usage, latency, and tool events that do not mutate turn state
- `startTurn(...)` and `ensureTurn(...)` for capture, STT, realtime provider, telephony, and meeting adapters
- `endTurn(...)` and `cancelTurn(...)` with stale `turnId` rejection before clearing the active turn
- `startOutputAudio(...)`, `emitOutputAudioDelta(...)`, and `finishOutputAudio(...)` for playback, marks, relay clear, and barge-in
- recent event retention for reconnect, diagnostics, hello/event discovery tests, and native UI replay
- compatibility normalization for legacy transport result names at adapter boundaries

The public API migration is adapter-first. Keep existing RPCs such as `talk.realtime.session`, `talk.realtime.relayAudio`, `talk.transcription.session`, `talk.transcription.relayAudio`, and `talk.handoff.*` while moving their internals onto the shared controller. Gateway-managed sessions expose the common model directly:

```ts
talk.session.create;
talk.session.inputAudio;
talk.session.control;
talk.session.toolResult;
talk.session.close;
```

The old RPCs stay as compatibility adapters while new clients use `talk.session.*` for gateway-relay realtime, gateway-relay transcription, and managed-room native STT/TTS sessions. Browser-owned WebRTC/provider-websocket sessions remain on `talk.realtime.session` because the browser owns provider negotiation and media transport there. The internal controller must be provider-agnostic and platform-agnostic: provider plugins own vendor sessions, voice-call owns telephony, Google Meet owns meeting details, and browser/native clients own capture and playback UX.

## VoiceClaw Runtime Scope

VoiceClaw is an adapter target, not a feature template for the unified runtime. We do not need every VoiceClaw product or API feature. We do want the useful realtime runtime primitives: live provider sessions, audio and optional video frames, interruption, cancellation, session lifecycle, rotation/resumption, metrics, latency reporting, and direct tools when explicitly authorized. Those should arrive as shared Talk primitives instead of VoiceClaw-only knobs.

The deliberate feature removal is request-time instruction override. Unified Talk instructions must be server-owned. If a capability depends on provider support, owner-scoped auth, or the selected brain strategy, the adapter should gate it through shared Talk capability metadata rather than deleting it. Do not preserve `instructionsOverride`; it is intentionally outside the unified Talk contract. Everything else in the existing realtime runtime is presumed in scope unless a later implementation review proves that it is dead, unsafe, or impossible to express as a shared Talk primitive.

Keep:

- `/voiceclaw/realtime` endpoint shape during migration
- existing auth expectations where they remain owner-scoped
- Gemini Live provider bridge
- audio input and output frames
- video frames when the selected provider supports them
- interruption and response cancellation
- session rotation and resumption where the provider supports them
- metrics and latency reporting
- direct tool calls behind the explicit `direct-tools` brain

Do not keep:

- request-time `instructionsOverride`
- VoiceClaw-only request fields that duplicate server-owned instructions, tool policy, provider selection, or session policy
- VoiceClaw-specific configuration names in new shared Talk APIs

Realtime instruction policy must come from server-side config, agent identity, selected brain strategy, or another owner-controlled policy surface. If a client sends `instructionsOverride`, the compatibility adapter should reject the request rather than silently applying, partially honoring, or translating it. Everything in the Keep list remains in scope and should migrate onto shared Talk primitives.

Compatibility here means "old entry point can route to the new runtime," not "old clients can keep every old knob forever." `/voiceclaw/realtime` should be allowed to return a clear unsupported-field error for retired request fields, especially `instructionsOverride`, while preserving the runtime behavior that still belongs in Talk.

## Event Vocabulary

All Talk sessions should emit a common event stream:

- `session.started`, `session.ready`, `session.replaced`, `session.closed`, `session.error`
- `turn.started`, `turn.ended`, `turn.cancelled`
- `capture.started`, `capture.stopped`, `capture.cancelled`, `capture.once`
- `input.audio.delta`, `input.audio.committed`
- `transcript.delta`, `transcript.done`
- `output.text.delta`, `output.text.done`
- `output.audio.started`, `output.audio.delta`, `output.audio.done`
- `tool.call`, `tool.progress`, `tool.result`, `tool.error`
- `usage.metrics`
- `latency.metrics`
- `health.changed`

Adapters may add vendor or surface metadata, but the common event names should be enough for UI, native clients, logs, tests, and metrics.

Every common event must use the same envelope:

```ts
type TalkEvent<TPayload = unknown> = {
  id: string;
  type: TalkEventType;
  sessionId: string;
  turnId?: string;
  captureId?: string;
  seq: number;
  timestamp: string;
  mode: TalkMode;
  transport: TalkTransport;
  brain: TalkBrain;
  provider?: string;
  final?: boolean;
  callId?: string;
  itemId?: string;
  parentId?: string;
  payload: TPayload;
};
```

`sessionId` is required for every event. `turnId` is required for every event tied to one user/assistant turn. `captureId` is required while push-to-talk capture is active. `seq` is monotonically increasing within a session. `callId`, `itemId`, and `parentId` correlate provider tool calls, realtime response items, TTS jobs, and relay frames. Replay, stale-output suppression, metrics, and tests should rely on these envelope fields rather than vendor-specific payload shapes.

Walkie-talkie clients need one extra timing rule: text-ready is not audio-ready. A client may show transcript text after `output.text.done`, but it should not transition from "thinking" to "speaking" until `output.audio.delta` or an explicit `output.audio.started` event arrives. That keeps hold music, waveform, replay, and barge-in UX honest when the agent turn finishes before TTS is ready.

## Walkie-Talkie App Primitives

The app should be buildable from the same primitives, not a parallel voice stack.

### Session Handoff

Voice handoff starts from an existing OpenClaw session. The handoff primitive should carry:

- canonical session id
- optional session key for human-readable thread lookup
- delivery route, such as channel and target
- caller identity and scope
- selected `TalkMode`, `TalkTransport`, and `TalkBrain`
- optional session-scoped provider, model, and voice ids
- expiration, revocation, and replacement policy

The existing Gateway session APIs and `chat.send`/agent delivery paths already cover the canonical conversation side. First-class Talk handoff RPCs provide the rendezvous primitive: `talk.handoff.create` returns an ephemeral room token or join URL, `talk.handoff.join` validates the later voice join without exposing stored token hashes, `talk.handoff.turnStart`/`turnEnd`/`turnCancel` drive the room turn lifecycle, and `talk.handoff.revoke` invalidates stale or replaced handoffs.

### Room and Rendezvous

The room model must allow one device or browser client to host multiple active voice handoffs for different sessions without cross-talk. A deterministic room key is fine for local or development flows, but the product path should prefer Gateway-owned room creation with caller auth, expiry, and revoke semantics.

The minimum room events are:

- `session.ready`
- `session.replaced`
- `turn.started`
- `turn.ended`
- `turn.cancelled`
- `session.closed`
- `session.error`

`managed-room` is public only through handoff clients. Browser `talk.realtime.session` should keep rejecting `managed-room` until the browser owns a real room client instead of treating it as a browser-session result shape.

### Push-To-Talk

Push-to-talk is a turn-control primitive, not a platform primitive. It should map to browser capture, native local capture, or node commands:

- `capture.started`
- `capture.stopped`
- `capture.cancelled`
- `capture.once`

Native node support has `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` command handlers. The Gateway policy treats them as first-class defaults only for trusted Talk-capable nodes: a node must advertise the `talk` capability or declare `talk.*` command support, and the command must still be present in the paired command snapshot.

### Provider Catalogs and Settings

Walkie-talkie settings should be per session or per device. The client should request STT, TTS, and realtime catalogs through Gateway, store only provider ids, model ids, voice ids, and locales, and never receive provider API keys or mutate global Talk provider defaults as a side effect of opening the app.

The catalog contract should describe which combinations are valid:

- local STT plus local TTS
- streaming STT plus provider TTS
- realtime provider with provider-native output audio
- Gateway relay when browser-safe credentials are not available
- managed room when the Gateway owns the session

### Canonical Transcript

The OpenClaw session is the source of truth. A walkie-talkie app may keep a local transcript cache for replay, export, reconnect, or offline UX, but the agent turn and durable transcript should go through the existing session delivery route. Transcript mirroring should be best effort and must not block the voice turn.

### Connectivity and Backgrounding

Native apps can use node pairing, `node.invoke`, and platform wake mechanisms when available. Browser or standalone web clients need either Gateway relay, a managed room, or hosted WebRTC signaling with ICE/TURN. Background continuous audio remains platform-limited; the product should promise foreground push-to-talk first and treat background capture as best effort.

### Cancellation and Replacement

Every turn should carry a turn token or capture id. Stale STT finals, stale agent replies, and stale TTS output must be ignored after `turn.cancelled` or `session.replaced`. This is required for "tap again to interrupt", reconnect replacement, and multi-session isolation.

Cancellation must also abort underlying work, not only hide stale output. A cancelled or replaced turn must:

- cancel provider responses or realtime sessions when the provider supports it
- abort agent consult and tool runtime work through an `AbortSignal`
- prevent newly queued side-effecting tools from starting after cancellation
- let already-started side-effecting tools report cancellation status instead of inventing success
- drain pending TTS jobs and stop audio playback/relay writes
- close or reset relay and managed-room streams tied to the stale turn
- emit one terminal cancellation event with the final abort reason

## Config Direction

The current public Talk config is speech-provider oriented. Keep it as the speech config and add realtime config beside it. Do not introduce a second `talk.speech` namespace during this refactor.

```ts
type TalkConfig = {
  provider?: string;
  providers?: Record<string, unknown>;
  realtime?: {
    provider?: string;
    model?: string;
    voice?: string;
    mode?: TalkMode;
    transport?: TalkTransport;
    brain?: TalkBrain;
  };
  input?: {
    interruptOnSpeech?: boolean;
    silenceTimeoutMs?: number;
  };
};
```

Rule: `talk.provider` and `talk.providers.*` continue to mean speech, STT, and TTS provider configuration. Realtime provider selection uses `talk.realtime.provider`, then registered realtime capabilities. Voice Call fallback inference should be deleted once the realtime config exists in schema, docs, forms, and doctor repair.

## Provider Contracts

Provider plugins should declare capabilities, not force core to infer behavior from ids:

```ts
type RealtimeVoiceProviderCapabilities = {
  transports: TalkTransport[];
  inputAudioFormats: AudioFormat[];
  outputAudioFormats: AudioFormat[];
  supportsBrowserSession?: boolean;
  supportsBargeIn?: boolean;
  supportsToolCalls?: boolean;
  supportsVideoFrames?: boolean;
  supportsSessionResumption?: boolean;
};
```

OpenAI owns OpenAI Realtime details. Google owns Gemini Live details, continuation, compression, and session resumption. STT plugins own streaming transcription. TTS plugins own synthesis and telephony-compatible output formats.

## Gateway Policy Boundary

Browser realtime should not run agent consult by calling `chat.send` directly. The browser may own the media connection when a provider requires it, but Gateway should own the consult/tool policy.

Target flow for browser-owned provider sessions:

1. Provider emits a tool call to the browser.
2. Browser forwards the structured tool call to Gateway with the session id.
3. Gateway validates the session, caller, tool policy, brain strategy, and owner permissions.
4. Gateway runs `agent-consult`, `direct-tools`, or rejects the call.
5. Browser submits the provider-specific tool result back to the provider.

Target flow for Gateway-owned sessions:

1. Provider emits a tool call to Gateway.
2. Gateway runs policy and tool handling directly.
3. Client only receives status, transcript, audio, and visible tool progress events.

## Surface Adapters

Adapters convert surface-specific IO into the shared model.

Browser adapter handles microphone capture, playback, WebRTC SDP, data channels, provider WebSocket framing, relay RPCs, and provider-specific tool result submission.

Native adapter handles local STT/TTS, push-to-talk, continuous listening, local interruption, audio session lifecycles, and optional Gateway realtime or managed-room clients. Core sees capabilities such as PCM input support, local TTS fallback, and barge-in support, not platform names.

Telephony adapter handles Twilio or Plivo media streams, G.711 u-law, stream ids, marks, clear events, backpressure, call lifecycle, and phone-specific interruption behavior.

Meeting adapter handles room lifecycle, participant context, echo suppression, meeting transcript context, and meeting-specific authorization.

VoiceClaw adapter handles `/voiceclaw/realtime`, auth expectations that remain owner-scoped, Gemini Live compatibility, audio/video frames, interruption, response cancellation, session rotation/resumption, metrics, latency reporting, and the `direct-tools` brain while using common Talk events internally. It must reject request-time `instructionsOverride` and must not introduce VoiceClaw-only policy fields into the shared Talk API.

## Migration Phases

### Phase 1: Contracts

- Add shared Talk mode, transport, brain, capabilities, command, and event types.
- Add a config resolver that preserves legacy `talk.provider`.
- Keep existing `RealtimeVoiceProvider` APIs while introducing capability metadata.
- Add handoff, room, capture, provider catalog, cancellation, and replacement event contracts.
- Make `talk.ptt.start`, `talk.ptt.stop`, `talk.ptt.cancel`, and `talk.ptt.once` explicit safe commands for Talk-capable nodes.
- Add protocol tests for no request-time instruction override.

### Phase 2: Gateway Tool Policy

- Add Gateway RPC for realtime tool calls from browser-owned provider sessions.
- Add Gateway RPCs for `talk.handoff.create`, `talk.handoff.join`, `talk.handoff.revoke`, and explicit handoff turn start/end/cancel, with session identity, expiry, revocation, join authorization, and event replay.
- Add session-scoped STT, TTS, and realtime provider catalog RPCs.
- Keep browser `openclaw_agent_consult` handling on `talk.realtime.toolCall`, not browser-side `chat.send`.
- Reuse existing agent consult runtime and tool allow policy.
- Add owner-only gate for `direct-tools`.

### Phase 3: Browser Runtime

- Normalize browser WebRTC, provider WebSocket, and relay adapters behind common Talk events.
- Keep `managed-room` scoped to handoff clients until the browser has a real room client.
- Add a walkie-talkie browser client path over Gateway relay or managed room.
- Keep provider credentials on Gateway; browser receives only ephemeral room/session credentials.
- Add browser tests proving realtime consult does not call `chat.send`.

### Phase 4: Native Runtime

- Make native Talk consume response events in the success path.
- Remove normal-path `chat.history` polling and keep history polling only as a degraded fallback if needed.
- Preserve local STT and local TTS fallback.
- Route native push-to-talk through the shared capture and turn events.
- Verify node command policy allows `talk.ptt.*` for trusted Talk-capable native nodes.
- Align native emitted state with common Talk events.

### Phase 5: VoiceClaw Runtime

- Rebase `/voiceclaw/realtime` onto the shared Talk session runtime.
- Keep the endpoint as a thin migration adapter and preserve auth expectations only where they map cleanly to the shared Talk contract.
- Remove request-time `instructionsOverride`; owner policy must come from server-side config, agent identity, or the selected brain strategy.
- Map Gemini Live metrics, latency reporting, rotation, resumption, interruption, cancellation, audio, video, and tool events into the common event stream.
- Keep `direct-tools` separate from `agent-consult`.
- Do not add VoiceClaw-specific config names, override fields, or client policy knobs to new Talk contracts.

### Phase 6: Voice Call and Meetings

- Convert Voice Call realtime into a telephony adapter over shared Talk sessions.
- Convert Voice Call streaming STT into explicit `stt-tts`.
- Convert Google Meet realtime into a meeting adapter over shared Talk sessions.
- Keep telephony marks, u-law, backpressure, participant context, and echo suppression in their owning adapters.

### Phase 7: Docs and Cleanup

- Update [Talk mode](/nodes/talk), [Control UI](/web/control-ui), [Gateway protocol](/gateway/protocol), [Media overview](/tools/media-overview), [Text-to-speech](/tools/tts), and plugin SDK docs.
- Retire duplicate event names after compatibility windows.
- Remove browser-side consult-through-chat code after all supported providers use Gateway tool policy.

## Test Matrix

- WebRTC plus `agent-consult`.
- Provider WebSocket plus `agent-consult`.
- Gateway relay plus `agent-consult`.
- Public clients updated to canonical transport names, or a versioned RPC proves old result names stay isolated until deletion.
- VoiceClaw compatibility plus `direct-tools`, without request-time `instructionsOverride`.
- Telephony WebSocket with marks, clear, interruption, and u-law.
- Meeting adapter with participant context and echo suppression.
- Native `stt-tts` with no `chat.history` polling in the normal success path.
- Transcription-only Gateway relay session with partial/final transcript Talk events and no assistant brain.
- TTS-only `talk.speak`.
- Walkie-talkie handoff from an existing session into a voice room.
- Two simultaneous walkie-talkie handoffs for the same host but different sessions with no transcript, audio, or turn-token cross-talk.
- Push-to-talk start, stop, cancel, and once through `node.invoke` on a trusted talk-capable node.
- Text-ready before TTS-ready, proving the client does not enter playback until audio starts.
- Session-scoped provider catalog selection that does not mutate global Talk config.
- Cancellation aborts provider work, agent consult, queued tools, TTS, and relay/room streams.
- Security checks for no instruction override, no browser standard API keys, owner-only direct tools, and session-scoped tool calls.

## End State

OpenClaw has one Talk architecture with three execution modes, four core transports, explicit brain strategies, provider-owned vendor logic, Gateway-owned tool policy, and adapters for browser, native, telephony, meetings, and VoiceClaw compatibility. Users get better Talk mode. Maintainers get one place to reason about sessions, events, policy, metrics, and tests.
