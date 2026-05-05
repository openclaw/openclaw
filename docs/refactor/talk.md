---
summary: "Breaking refactor plan for one Talk architecture across realtime voice, STT/TTS, browser, native, telephony, meetings, and walkie-talkie handoff"
read_when:
  - Refactoring Talk mode, realtime voice, voice-call, Google Meet, browser realtime voice, native push-to-talk, STT, or TTS
  - Changing Talk Gateway protocol, provider contracts, realtime transports, managed rooms, audio events, cancellation, or tool policy
  - Deciding whether a voice feature belongs in core, a provider plugin, a native app, a meeting adapter, or a telephony adapter
title: "Talk refactor plan"
---

# Talk Refactor Plan

This is the breaking-clean plan for unifying every live voice path behind one
Talk architecture.

The old architecture grew by product surface: browser realtime, Gateway relay,
managed native handoff, streaming transcription, Voice Call, Google Meet, local
STT/TTS, one-shot TTS, and a retired realtime WebSocket endpoint each learned
their own names for sessions, turns, capture, output, barge-in, tool calls,
cancellation, and transcript events.

The new architecture grows by primitive. There is one public Talk API, one
event envelope, one turn model, one cancellation contract, one provider policy
boundary, and one place for shared runtime state. Browser, native, telephony,
meetings, and walkie-talkie become adapters over those primitives.

## Product Target

OpenClaw supports three Talk products:

| Product               | User experience                                                         | Mode            |
| --------------------- | ----------------------------------------------------------------------- | --------------- |
| Realtime conversation | Low-latency duplex speech with interruption and provider tool calls     | `realtime`      |
| Walkie-talkie         | Press or hold to speak, release, then hear OpenClaw answer              | `stt-tts`       |
| Transcription         | Live captions, dictation, notes, meeting transcript, no assistant audio | `transcription` |

All three products share session identity, join/reconnect state, turn and
capture ids, input audio metadata, output text/audio state, transcript finality,
tool-call correlation, cancellation, replay, provider capabilities, policy,
auth, and observability.

One-shot uploaded audio and one-shot TTS do not need live Talk session state
unless they participate in live capture, turns, interruption, replay, or
cancellation.

## Hard Decisions

This refactor intentionally removes compatibility that would keep the design
muddy:

- remove public `talk.realtime.*` RPCs
- remove public `talk.transcription.*` RPCs
- remove public `talk.handoff.*` RPCs
- remove generic `talk.session.inputAudio`, `talk.session.control`, and
  `talk.session.toolResult`
- remove old relay event channels
- remove `/voiceclaw/realtime`
- remove `src/gateway/voiceclaw-realtime/`
- remove request-time instruction overrides
- keep `talk.speak` as one-shot TTS, not a live session API
- keep legacy realtime config repair in doctor, not startup
- keep platform and product names out of core branching

## Vocabulary

Keep mode, transport, brain, and surface separate.

```ts
type TalkMode = "realtime" | "stt-tts" | "transcription";

type TalkTransport = "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";

type TalkBrain = "agent-consult" | "direct-tools" | "none";
```

### Modes

`realtime` means a provider owns a live voice session. Audio goes in, audio
comes out, interruptions are possible, and provider tool calls may happen during
one provider session.

`stt-tts` means input speech is transcribed, OpenClaw answers as text, and TTS
renders the answer. This is the native Talk and walkie-talkie path when a full
duplex provider session is not the right shape.

`transcription` means speech-to-text without assistant audio output. It covers
captions, dictation, notes, meeting transcript capture, and live voice-note
ingestion.

### Transports

`webrtc` is client-owned SDP/media/data-channel transport. It fits browser-owned
OpenAI Realtime sessions with ephemeral credentials.

`provider-websocket` is client-owned provider JSON and audio framing. It fits
browser-owned Google Live style sessions.

`gateway-relay` means the Gateway owns the provider connection. The client sends
authenticated audio frames to the Gateway and receives `talk.event` plus audio
output through Gateway-managed relay state.

`managed-room` means the Gateway owns a room-like session that clients can join,
replace, and drive with explicit turn verbs. It is the primitive for
walkie-talkie and native handoff.

Telephony and meetings are not core transports. They are adapters that map
phone or meeting media into `gateway-relay`, `managed-room`, or `stt-tts` while
keeping call and meeting lifecycle outside core.

### Brain Strategies

`agent-consult` means provider tool calls or session turns consult an OpenClaw
agent. Gateway owns prompt construction, context selection, authorization, abort
signals, and final result delivery.

`direct-tools` means a trusted first-party surface can call selected OpenClaw
tools directly through Gateway policy. Keep this privileged.

`none` means transcription-only, external orchestration, or no OpenClaw tool
access.

## Ownership Boundaries

Core owns generic Talk semantics:

- mode, transport, brain, codec, and audio descriptors
- session records and session ownership
- turn ids and capture ids
- event envelope, sequencing, replay, and stale-output suppression
- active capture state
- active assistant output state
- replacement and reconnect state
- cancellation propagation
- tool policy and tool-call correlation
- usage, latency, and health events

Provider plugins own vendor behavior:

- OpenAI Realtime SDP and data-channel details
- Google Live WebSocket framing
- streaming STT provider details
- TTS provider details
- provider auth, model, voice, codec, and resume quirks
- provider capability declarations

Surface adapters own IO and product quirks:

- browser capture and playback
- native audio sessions, local speech engines, and foreground Talk UX
- node command dispatch
- telephony media streams, marks, clear events, u-law, and call lifecycle
- meeting join/leave, participants, echo suppression, and authorization

Core may store optional surface metadata for diagnostics. Core must not branch
on browser, iOS, Android, macOS, Google Meet, Voice Call, or any retired product
name.

## Final Gateway API

The public Gateway surface is deliberately small:

```ts
// Discovery and configuration.
talk.catalog;
talk.config;

// One-shot speech output.
talk.speak;

// Client-owned provider sessions.
talk.client.create;
talk.client.toolCall;

// Gateway-owned live sessions.
talk.session.create;
talk.session.join;
talk.session.appendAudio;
talk.session.startTurn;
talk.session.endTurn;
talk.session.cancelTurn;
talk.session.cancelOutput;
talk.session.submitToolResult;
talk.session.close;

// Events and foreground node mode.
talk.event;
talk.mode;
```

Use `talk.client.*` when the client owns provider media transport. Use
`talk.session.*` when the Gateway owns live session state.

`talk.mode` is the existing foreground node mode broadcast. It can stay, but it
is not part of the Talk session control API.

### Supported Creation Matrix

| Method                | Mode            | Transport            | Brain           | Owner   |
| --------------------- | --------------- | -------------------- | --------------- | ------- |
| `talk.client.create`  | `realtime`      | `webrtc`             | `agent-consult` | client  |
| `talk.client.create`  | `realtime`      | `provider-websocket` | `agent-consult` | client  |
| `talk.session.create` | `realtime`      | `gateway-relay`      | `agent-consult` | Gateway |
| `talk.session.create` | `transcription` | `gateway-relay`      | `none`          | Gateway |
| `talk.session.create` | `stt-tts`       | `managed-room`       | `agent-consult` | Gateway |
| `talk.session.create` | `stt-tts`       | `managed-room`       | `direct-tools`  | Gateway |

Reject combinations that blur ownership. `talk.client.create` must reject
Gateway-owned transports. `talk.session.create` must reject client-owned
transports.

## Removed API

Remove these names from handlers, method lists, scopes, protocol schemas,
generated clients, broadcast guards, tests, and docs except explicit migration
tables:

| Removed                         | Replacement                                              |
| ------------------------------- | -------------------------------------------------------- |
| `talk.realtime.session`         | `talk.client.create`                                     |
| `talk.realtime.toolCall`        | `talk.client.toolCall`                                   |
| `talk.realtime.relayAudio`      | `talk.session.appendAudio`                               |
| `talk.realtime.relayCancel`     | `talk.session.cancelOutput` or `talk.session.cancelTurn` |
| `talk.realtime.relayMark`       | internal relay output state                              |
| `talk.realtime.relayToolResult` | `talk.session.submitToolResult`                          |
| `talk.realtime.relayClose`      | `talk.session.close`                                     |
| `talk.realtime.relay`           | `talk.event`                                             |
| `talk.transcription.session`    | `talk.session.create({ mode: "transcription" })`         |
| `talk.transcription.audio`      | `talk.session.appendAudio`                               |
| `talk.transcription.cancel`     | `talk.session.cancelTurn`                                |
| `talk.transcription.close`      | `talk.session.close`                                     |
| `talk.transcription.relay`      | `talk.event`                                             |
| `talk.handoff.create`           | `talk.session.create({ transport: "managed-room" })`     |
| `talk.handoff.join`             | `talk.session.join`                                      |
| `talk.handoff.revoke`           | `talk.session.close`                                     |
| `talk.session.inputAudio`       | `talk.session.appendAudio`                               |
| `talk.session.control`          | explicit turn/output verbs                               |
| `talk.session.toolResult`       | `talk.session.submitToolResult`                          |

Delete this endpoint:

```text
/voiceclaw/realtime
```

Delete this folder:

```text
src/gateway/voiceclaw-realtime/
```

Do not leave a compatibility namespace around retired code.

## Target Source Layout

Shared runtime:

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

Gateway adapters:

```text
src/gateway/server-methods/
  talk.ts          # catalog, config, speak, mode, composition
  talk-client.ts   # client-owned provider sessions
  talk-session.ts  # Gateway-owned live sessions
```

Gateway relay helpers can exist while the code moves, but the long-term shape
is that relay, transcription, and handoff state use `src/talk` primitives
instead of each reimplementing turns and events.

Public SDK:

```text
src/plugin-sdk/realtime-voice.ts
```

Keep this SDK subpath as the stable plugin import facade. It may re-export
Talk runtime contracts, but plugin authors should not import core file layout.

## Event Contract

All live paths emit `talk.event` with the envelope defined in
[Talk API and runtime contract](/refactor/talk-api-contract). The required
shape is: `id`, `type`, `sessionId`, `seq`, `timestamp`, `mode`, `transport`,
`brain`, and `payload`, with `turnId`, `captureId`, `callId`, `itemId`, and
`parentId` when the event is tied to turn, capture, provider item, tool call, or
TTS output.

Core event families are `session.*`, `turn.*`, `capture.*`, `input.audio.*`,
`transcript.*`, `output.text.*`, `output.audio.*`, `tool.*`, `usage.metrics`,
`latency.metrics`, and `health.changed`. Payloads must not duplicate large raw
audio frames when the transport already carries them. Text-ready is not
audio-ready; clients enter playback state only on audio events.

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

Barge-in requires real speech: provider speech-started, local VAD, or an
adapter-owned speech detector. Silence, echo, or microphone buffers alone must
not cancel assistant output.

## Config Contract

Config stays under `talk`; do not add `talk.speech`. `talk.provider` and
`talk.providers.*` remain speech/STT/TTS provider config. Realtime selectors
live under `talk.realtime.provider`, `talk.realtime.providers.*`, `model`,
`voice`, `mode`, `transport`, and `brain`.

`talk.config` returns effective config without secrets unless privileged.
`talk.catalog` returns provider capabilities, not inferred provider-id guesses.
Doctor migrates old realtime placement into `talk.realtime`; runtime startup
does not reinterpret Voice Call, STT, or TTS config as realtime config.

## Surface Mapping

| Surface                         | Talk mapping                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Browser WebRTC                  | `talk.client.create`, client-owned provider media, `talk.client.toolCall` for provider tool calls     |
| Browser provider WebSocket      | `talk.client.create`, browser-owned provider framing, Gateway-owned credentials and policy            |
| Browser Gateway relay           | `talk.session.create`, `appendAudio`, `submitToolResult`, `cancelOutput`, `close`, and `talk.event`   |
| Native push-to-talk             | `stt-tts` plus `managed-room`; press/startTurn, release/endTurn, cancel/cancelTurn                    |
| Walkie-talkie                   | managed-room join/replacement plus shared turn/output events                                          |
| Voice Call                      | telephony adapter over Talk events; call ids, stream ids, u-law, marks, clear events stay plugin side |
| Google Meet and future meetings | meeting adapter over Talk events; participant state, permissions, mute, and echo suppression stay out |

See [Talk surface mapping](/refactor/talk-surfaces) for the adapter-level
rules.

## Detailed Refactor Phases

### Phase 1: Protocol Is The Source Of Truth

- define final `talk.client.*`, `talk.session.*`, `talk.event`, `talk.catalog`, `talk.config`, `talk.speak`, and `talk.mode`
- delete removed RPCs from method lists and generated metadata
- delete removed event channels from hello feature advertising
- classify every final method in `METHOD_SCOPE_GROUPS`
- regenerate TypeScript and Swift protocol clients
- add protocol tests proving removed names are absent

Exit criteria: generated clients expose only the final public Talk API.

### Phase 2: Shared Runtime Becomes `src/talk`

- move provider-agnostic realtime voice modules into `src/talk`
- keep the plugin SDK facade at `openclaw/plugin-sdk/realtime-voice`
- rename logs and tests from realtime-voice wording to Talk wording where that improves clarity
- centralize event sequencing, active turn state, capture state, output state, stale-turn rejection, and replay history
- keep provider adapters out of this folder

Exit criteria: core and bundled surfaces import shared semantics from `src/talk`
or the SDK facade, not from surface-local helpers.

### Phase 3: Gateway Method Split

- make `talk.ts` a composition point for catalog, config, speak, mode, client, and session handlers
- put client-owned provider session methods in `talk-client.ts`
- put Gateway-owned session methods in `talk-session.ts`
- make relay, transcription, and managed-room handlers thin adapters over shared runtime primitives
- route session replacement notifications to the displaced connection
- reject stale turn completion before mutating active room state

Exit criteria: public RPC handlers read like API adapters, not separate Talk
implementations.

### Phase 4: Browser UI Uses The Final API

- update WebRTC and provider WebSocket startup to `talk.client.create`
- update browser provider tool calls to `talk.client.toolCall`
- update Gateway relay startup to `talk.session.create`
- update relay audio to `talk.session.appendAudio`
- update relay tool result submission to `talk.session.submitToolResult`
- update relay close to `talk.session.close`
- listen only to `talk.event`
- handle aborted consult runs immediately instead of timing out
- gate relay barge-in on speech or VAD

Exit criteria: UI tests contain no calls to removed Talk RPC names.

### Phase 5: Native And Nodes Become Event-Driven

- map native push-to-talk into managed-room sessions
- start, end, cancel, and replace turns through explicit session verbs
- clean capture state when push-to-talk start fails
- keep local STT and TTS as native adapter behavior
- remove chat-history polling from the success path
- keep fallback polling only if there is an explicit degraded-mode test

Exit criteria: native Talk success path is driven by `talk.event`, not hidden
chat side effects.

### Phase 6: Telephony And Meetings Become Adapters

- map Voice Call realtime and streaming STT into Talk event/cancellation semantics
- create or guard a turn before early speech cancellation events
- keep telephony codec, marks, clear events, and call lifecycle outside core
- map Google Meet transcript and assistant output into `talk.event`
- keep participant and echo-suppression behavior in the meeting adapter
- pass abort signals into agent consult and tool runtime

Exit criteria: Voice Call and meetings share event and cancellation semantics
without introducing telephony or meeting branches in core.

### Phase 7: Config And Doctor Cleanup

- keep `talk.provider` and `talk.providers.*` as speech/STT/TTS config
- keep realtime voice selectors under `talk.realtime`
- make `talk.config` return only resolved effective provider data
- repair legacy realtime placement in doctor
- document that runtime startup does not guess or rewrite config
- update SDK migration, Gateway protocol, Talk node, Control UI, and TTS docs

Exit criteria: no second speech namespace, no startup migrations, and no
ambiguous active provider in `talk.config`.

### Phase 8: Delete The Retired Stack

- remove `/voiceclaw/realtime`
- delete `src/gateway/voiceclaw-realtime/`
- remove request-time `instructionsOverride`
- remove old RPC handlers, scopes, broadcast guards, protocol schemas, generated clients, docs, and UI calls
- keep old names only in explicit migration tables and negative tests

Exit criteria: repository search finds removed public names only in migration
notes or tests that assert absence.

## Test And Verification Plan

The full matrix lives in
[Talk refactor execution checklist](/refactor/talk-execution). The required
proof areas are:

- protocol and generated clients expose only the final Talk API
- Gateway tests cover every `talk.client.*` and `talk.session.*` method
- UI tests prove browser WebRTC, provider WebSocket, and relay paths use the final API
- native tests prove managed-room push-to-talk cleanup, replacement, and event flow
- Voice Call and meeting tests prove early speech, barge-in, output state, and cancellation behavior
- config tests prove `talk.config` reports only resolved effective provider data
- architecture searches prove removed RPCs, events, endpoint, folder, and instruction override stay gone
- docs, protocol generation, SDK API checks, Android tests, build, and `pnpm check:changed` pass before push

## Definition Of Done

The refactor is complete when:

- final API is the only advertised public API
- removed RPCs are gone from handlers, scopes, method lists, schemas, generated clients, docs, and UI
- removed event channels are gone
- retired realtime HTTP endpoint is gone
- retired realtime folder is gone
- browser Talk works through `talk.client.*` or `talk.session.*`
- native Talk works through session events
- streaming STT works through `talk.session.*`
- TTS one-shot remains `talk.speak`
- walkie-talkie works through managed-room sessions
- Voice Call and meetings use shared events and cancellation semantics
- cancellation aborts underlying work
- event envelopes are consistent
- config migration is handled by doctor
- tests prove the deleted API cannot accidentally return

Supporting details:

- [Talk API and runtime contract](/refactor/talk-api-contract)
- [Talk surface mapping](/refactor/talk-surfaces)
- [Talk refactor execution checklist](/refactor/talk-execution)

The end state: one Talk system, a small public API, provider-owned vendor
logic, surface-owned IO, and a Gateway core that owns policy, events, sessions,
turns, cancellation, and observability.
