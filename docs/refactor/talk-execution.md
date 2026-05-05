---
summary: "Implementation packages, deletion checklist, test matrix, and verification commands for the Talk refactor"
read_when:
  - Implementing the Talk refactor plan
  - Deleting legacy Talk RPCs, event channels, or realtime endpoint code
  - Verifying browser, native, telephony, meeting, STT, or TTS Talk behavior after refactor work
title: "Talk refactor execution checklist"
---

# Talk Refactor Execution Checklist

Use this as the PR tracker for [Talk refactor plan](/refactor/talk).

## Implementation Packages

### Package 1: Protocol

- update `src/gateway/protocol/schema/channels.ts`
- update `src/gateway/protocol/schema/protocol-schemas.ts`
- update `src/gateway/protocol/schema/types.ts`
- update `src/gateway/protocol/index.ts`
- regenerate generated protocol clients
- remove old schemas from generated metadata
- update protocol tests

Done when old RPC/event names are absent from generated protocol output.

### Package 2: Gateway Methods

- split client-owned methods into `talk-client.ts`
- keep session-owned methods in `talk-session.ts`
- keep catalog/config/speak/mode in `talk.ts`
- classify every new method in method scopes
- advertise only `talk.event` in hello event features
- remove old method list entries
- update authorization tests

Done when every public Talk method has an explicit scope.

### Package 3: Session Runtime

- add `src/talk` primitives
- move event sequencing into shared runtime
- move stale-turn rejection into shared runtime
- move active output state into shared runtime
- move cancellation bookkeeping into shared runtime
- expose small test helpers

Done when relay, transcription, handoff, telephony, and meetings do not each
invent event and turn bookkeeping.

### Package 4: Browser UI

- update realtime startup to `talk.client.create`
- update realtime tool consult to `talk.client.toolCall`
- update relay startup to `talk.session.create`
- update relay audio to `talk.session.appendAudio`
- update relay tool result to `talk.session.submitToolResult`
- update relay output cancel to `talk.session.cancelOutput`
- update relay close to `talk.session.close`
- listen only to `talk.event`
- remove relay mark RPC

Done when UI tests prove no removed RPC names remain.

### Package 5: Native And Nodes

- route native Talk through session events
- map push-to-talk commands to managed-room turn lifecycle
- clean capture state on failed start
- keep local STT/TTS as adapter behavior
- remove chat-history polling from the success path
- keep fallback polling only if explicitly needed

Done when native voice success path is event-driven.

### Package 6: Voice Call

- map telephony realtime events into `talk.event`
- map local speech detection to `startTurn`, `cancelOutput`, and `cancelTurn`
- pass abort through agent consult and tools
- keep marks, clear, u-law, and call lifecycle in the plugin
- add tests for early speech before provider speech-started

Done when Voice Call shares event and cancellation semantics without leaking
telephony into core.

### Package 7: Meetings

- map meeting speech and transcript state into `talk.event`
- keep participant and room state in meeting adapter
- add echo-suppression aware barge-in tests
- ensure meeting adapters can choose realtime, transcription, or `stt-tts`

Done when meeting behavior is an adapter over Talk, not a parallel realtime loop.

### Package 8: Doctor And Migration

- detect old realtime selectors outside `talk.realtime`
- write explicit `talk.realtime.provider`, `model`, `voice`, `transport`, and `brain`
- report removed RPC names when logs show old clients
- keep startup free of hidden config rewrites
- update SDK migration, Gateway protocol, Talk node, Control UI, and TTS docs

Done when runtime config is explicit and docs mention removed API only in
migration notes.

## Deletion Checklist

Delete or prove absent:

- `src/gateway/voiceclaw-realtime/`
- `/voiceclaw/realtime`
- `instructionsOverride`
- `talk.realtime.*` public RPCs
- `talk.transcription.*` public RPCs
- `talk.handoff.*` public RPCs
- `talk.session.inputAudio`
- `talk.session.control`
- `talk.session.toolResult`
- `talk.realtime.relay`
- `talk.transcription.relay`
- old generated protocol models
- old UI relay method calls

Keep only these old names in explicit migration tables.

## Test Matrix

Protocol:

- final methods exist in protocol schemas
- removed methods are absent from protocol schemas
- final event is advertised in hello features
- removed events are absent from broadcast guards
- generated clients match schema
- request-time instruction override is rejected or impossible by schema

Gateway:

- `talk.client.create` creates WebRTC session result
- `talk.client.create` creates provider WebSocket session result
- `talk.client.create` rejects Gateway-owned transports
- `talk.client.toolCall` validates caller, session, brain, and policy
- `talk.session.create` creates realtime Gateway relay
- `talk.session.create` creates transcription relay
- `talk.session.create` creates STT/TTS managed room
- `talk.session.create` rejects client-owned transports
- `talk.session.join` replacement notifies displaced client
- `talk.session.appendAudio` routes to relay/transcription session
- `talk.session.startTurn` starts managed-room turn
- `talk.session.endTurn` rejects stale turn ids
- `talk.session.cancelTurn` aborts provider, agent, tools, TTS, and streams
- `talk.session.cancelOutput` cancels playback only
- `talk.session.submitToolResult` binds to provider call id
- `talk.session.close` emits terminal event and releases resources

Browser:

- WebRTC path calls `talk.client.create`
- provider WebSocket path calls `talk.client.create`
- provider tool calls use `talk.client.toolCall`
- Gateway relay uses only `talk.session.*`
- Gateway relay listens only to `talk.event`
- barge-in requires speech/VAD
- relay close rejects or aborts pending consult runs
- no removed RPC names in UI tests

Native:

- push-to-talk start emits capture/turn events
- failed push-to-talk start cleans capture state
- cancel clears capture and output state
- STT/TTS success path is event-driven
- fallback polling is explicit and tested if kept
- node policy rejects untrusted Talk commands

Telephony:

- early speech before provider speech-started creates or guards turn before cancellation
- marks and clear events map to output state
- u-law codec stays adapter-owned
- cancellation aborts consult run
- closed call prevents stale tool result submission

Meetings:

- participant context appears as metadata, not core branching
- echo suppression prevents false barge-in
- transcript events use common envelope
- meeting close aborts active work

Architecture:

- no removed public RPC names in protocol metadata
- no retired realtime endpoint route
- no retired realtime folder
- no request-time instruction override field
- no core branches on app platform names
- provider behavior comes from capabilities

## Verification Commands

Focused local loop:

```sh
pnpm test src/gateway/protocol/index.test.ts
pnpm test src/gateway/server-methods/talk.test.ts
pnpm test src/gateway/method-scopes.test.ts src/gateway/server-methods-list.test.ts
pnpm test src/gateway/talk-realtime-relay.test.ts src/gateway/talk-transcription-relay.test.ts
pnpm test ui/src/ui/realtime-talk.test.ts ui/src/ui/realtime-talk-gateway-relay.test.ts ui/src/ui/realtime-talk-webrtc.test.ts ui/src/ui/realtime-talk-google-live.test.ts
pnpm exec oxfmt --check --threads=1 docs/refactor/talk.md docs/refactor/talk-execution.md
```

Generation and docs:

```sh
pnpm protocol:gen && pnpm protocol:gen:swift
pnpm docs:check-mdx
pnpm plugin-sdk:api:check
```

Broad gate before push:

```sh
pnpm check:changed
```

Use Testbox for broad gates on maintainer machines.
