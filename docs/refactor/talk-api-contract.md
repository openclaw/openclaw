---
summary: "Detailed API, event, runtime, cancellation, and tool-policy contract for the Talk refactor"
read_when:
  - Implementing Talk Gateway methods or protocol schemas
  - Changing Talk config, events, cancellation, or provider tool policy
  - Reviewing whether a Talk behavior belongs in core or an adapter
title: "Talk API and runtime contract"
---

# Talk API And Runtime Contract

This is the detailed contract for [Talk refactor plan](/refactor/talk).

## Config Contract

Config stays under the existing `talk` object. Do not add `talk.speech` in this
refactor.

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
    providers?: Record<string, unknown>;
  };
  input?: {
    interruptOnSpeech?: boolean;
    silenceTimeoutMs?: number;
  };
};
```

Rules:

- `talk.provider` and `talk.providers.*` remain speech/STT/TTS provider config.
- `talk.realtime.provider` and `talk.realtime.providers.*` are realtime voice provider config.
- `talk.config` returns effective config without secrets unless privileged.
- `talk.catalog` returns capabilities, not inferred provider-id guesses.
- Doctor migrates old realtime selectors into `talk.realtime`.
- Runtime does not silently reinterpret Voice Call or TTS config as realtime config.

## Method Semantics

### `talk.catalog`

Returns effective Talk capabilities:

- modes
- transports
- brain strategies
- providers
- models
- voices
- input audio formats
- output audio formats
- browser-safe client session support
- Gateway relay support
- managed-room support
- local STT/TTS support

Provider capability declarations drive this. Core must not infer support from
provider ids.

### `talk.speak`

One-shot TTS:

```ts
await gateway.request("talk.speak", {
  text: "Ready.",
  voice: "alloy",
});
```

`talk.speak` does not create live session state, turn state, transcript state,
barge-in state, or provider realtime state.

### `talk.client.create`

Creates a client-owned provider session while Gateway still owns config,
instructions, credentials, and tool policy.

Use it for browser WebRTC, browser provider WebSocket, and native provider media
sessions that require client-owned sockets. Reject `gateway-relay` and
`managed-room`; the error points clients to `talk.session.create`.

### `talk.client.toolCall`

Forwards provider tool calls from client-owned provider sessions to Gateway
policy:

```ts
await gateway.request("talk.client.toolCall", {
  sessionId,
  callId,
  name,
  argumentsJson,
});
```

Validate session identity, caller ownership, brain strategy, and policy. Pass an
`AbortSignal` into agent/tool runtime, reject stale or closed sessions, and never
accept request-time instructions.

### `talk.session.create`

Creates a Gateway-owned live Talk session.

| Mode            | Transport       | Brain           | Owner               |
| --------------- | --------------- | --------------- | ------------------- |
| `realtime`      | `gateway-relay` | `agent-consult` | Gateway             |
| `transcription` | `gateway-relay` | `none`          | Gateway             |
| `stt-tts`       | `managed-room`  | `agent-consult` | Gateway/client room |
| `stt-tts`       | `managed-room`  | `direct-tools`  | trusted room        |

Reject `webrtc` and `provider-websocket`; the error points clients to
`talk.client.create`.

### `talk.session.join`

Joins or reconnects to a Gateway-owned managed room. Validate session id and
token, never expose token hashes, emit `session.replaced` to the displaced
client, and emit `session.ready` to the new owner.

### `talk.session.appendAudio`

Appends an input audio frame to a Gateway-owned relay session:

```ts
await gateway.request("talk.session.appendAudio", {
  sessionId,
  audioBase64,
  timestamp,
});
```

Use for realtime Gateway relay and streaming transcription. Do not use this for
managed-room native push-to-talk when the native node captures audio locally and
returns transcript/output through node command results.

### Turn Verbs

Use explicit verbs instead of generic controls:

```ts
await gateway.request("talk.session.startTurn", { sessionId });
await gateway.request("talk.session.endTurn", { sessionId, turnId });
await gateway.request("talk.session.cancelTurn", { sessionId, turnId, reason });
await gateway.request("talk.session.cancelOutput", { sessionId, turnId, reason });
```

`endTurn` rejects stale `turnId` before clearing active state. `cancelTurn`
aborts capture, STT, provider response, agent consult, tools, TTS, relay output,
and room streams tied to that turn. `cancelOutput` stops assistant audio without
necessarily ending the user turn. Barge-in must be speech/VAD gated.

### `talk.session.submitToolResult`

Completes a provider tool call emitted inside a Gateway-owned relay session:

```ts
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  output,
});
```

### `talk.session.close`

Closes a Gateway-owned session. Close emits one terminal event, stops capture and
playback, aborts provider and agent work, drains TTS, revokes room join state,
and removes retained state after its replay/debug window.

## Event Contract

All live Talk paths emit one public event channel:

```ts
talk.event;
```

Every event uses this envelope:

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
  source?: string;
  payload: TPayload;
};
```

Core event types include `session.*`, `turn.*`, `capture.*`, `input.audio.*`,
`transcript.*`, `output.text.*`, `output.audio.*`, `tool.*`, `usage.metrics`,
`latency.metrics`, and `health.changed`.

Rules:

- `sessionId` is required for every event.
- `turnId` is required for turn-bound input, output, transcript, tool, and cancellation events.
- `captureId` is required while capture is active.
- `seq` monotonically increases per session.
- `timestamp` uses ISO 8601 UTC.
- `callId`, `itemId`, and `parentId` correlate provider responses, tool calls, TTS jobs, and relay frames.
- payloads must not duplicate large raw audio frames when transport already carries them.
- consumers should rely on envelope fields instead of provider-specific payloads.

Text-ready is not audio-ready. Clients may show text after `output.text.done`,
but should not enter speaking/playback state until `output.audio.started` or
`output.audio.delta`.

## Shared Runtime Target

Keep one provider-agnostic runtime under `src/talk`. The first pass keeps names
close to the old runtime modules so the move stays reviewable:

```text
src/talk/
  audio-codec.ts
  agent-consult-runtime.ts
  agent-consult-tool.ts
  agent-talkback-runtime.ts
  fast-context-runtime.ts
  provider-registry.ts
  provider-resolver.ts
  provider-types.ts
  session-log-runtime.ts
  session-runtime.ts
  talk-events.ts
  talk-session-controller.ts
```

New code should import the shared runtime from `src/talk` inside core. Plugins
that already use the stable SDK subpath keep importing
`openclaw/plugin-sdk/realtime-voice`; that facade re-exports the Talk runtime
contract without exposing core file layout.

Responsibilities:

- normalize modes, transports, brains, codecs, and audio metadata
- create, close, and replace session records
- allocate turn ids and capture ids
- reject stale turn ids before mutation
- sequence events
- retain recent events for replay, reconnect, and diagnostics
- track active input capture and assistant output
- coordinate barge-in and output cancellation
- propagate abort signals
- register provider tool calls and bind tool results
- expose test builders for session/event assertions

Gateway method files should become thin adapters:

```text
src/gateway/server-methods/
  talk.ts
  talk-client.ts
  talk-session.ts
```

Internal Gateway helpers may exist only as staging files while code moves to
`src/talk`.

## Cancellation Contract

Cancellation must abort underlying work, not only ignore stale output.

When a turn or session is cancelled:

- provider realtime response is cancelled when supported
- provider session is closed or reset when cancellation cannot be scoped
- streaming STT receives abort
- agent consult receives abort
- queued tools do not start after abort
- already-started side-effecting tools receive abort and report cancellation
- pending TTS jobs are drained
- playback sources are stopped
- relay streams are cleared
- managed-room capture and output state reset
- stale finals and stale audio deltas are ignored
- one terminal cancellation event is emitted

Barge-in uses VAD or provider speech-started signals, ignores silence and echo,
cancels output only after real user speech, and starts or ensures a turn before
emitting `turn.cancelled`.

## Tool Policy Contract

Gateway owns Talk tool policy.

Client-owned flow: `talk.client.create`, provider tool call to client,
`talk.client.toolCall`, Gateway policy validation, agent/direct-tool execution,
client result submission to provider.

Gateway-owned flow: `talk.session.create`, provider tool call to Gateway,
Gateway policy validation, agent/direct-tool execution, provider result
submission, `talk.event` emission.

No Talk path accepts caller-provided instructions. Gateway builds instructions
from trusted config and session context.
