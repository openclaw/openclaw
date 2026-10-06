---
summary: "Migrating realtime voice, telephony, and meeting code to the unified Talk session API"
read_when:
  - You maintain a realtime voice, telephony, or meeting plugin
  - You are moving off the removed talk.realtime.*, talk.transcription.*, or talk.handoff.* methods
title: "Talk and realtime voice migration"
sidebarTitle: "Talk and voice"
---

The unified Talk session controller, its supported session combinations, and the method map from the removed Talk families. Part of the [Plugin SDK migration](/plugins/sdk-migration) guide.

## Talk and realtime voice migration

Realtime voice, telephony, meeting, and browser Talk code shares one Talk
session controller exported by `openclaw/plugin-sdk/realtime-voice`. The
controller owns the common Talk event envelope, active turn state, capture
state, output-audio state, recent event history, and stale-turn rejection.
Provider plugins own vendor-specific realtime sessions. Browser-meeting plugins
use `openclaw/plugin-sdk/meeting-runtime` for session, browser, audio, node-host,
agent-consult, and voice-call mechanics, then implement `MeetingPlatformAdapter`
for URL rules, DOM scripts, manual-action mapping, captions, creation, and dial-in
plans. Platform REST APIs, OAuth, artifacts, selectors, and wire names remain in
the plugin. Browser permission plans receive the requested meeting URL so each
platform can grant only its exact supported origins. Session runtimes must also
normalize platform-specific live health after confirmed browser departure;
historical transcript fields may remain, but caption and audio readiness must
not stay active after leave.

All bundled surfaces run on the shared controller: browser relay,
managed-room handoff, voice-call realtime, voice-call streaming STT, Google
Meet realtime, and native push-to-talk. Gateway advertises one live Talk event
channel in `hello-ok.features.events`: `talk.event`.

New code should not call `createTalkEventSequencer(...)` directly unless
implementing a low-level adapter or test fixture. Use the shared controller so
turn-scoped events cannot be emitted without a turn id, stale `turnEnd` /
`turnCancel` calls cannot clear a newer active turn, and output-audio
lifecycle events stay consistent across telephony, meetings, browser relay,
managed-room handoff, and native Talk clients.

The public API shape:

```typescript
// Gateway-owned Talk session API.
await gateway.request("talk.session.create", {
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.session.appendAudio", { sessionId, audioBase64 });
// Capture this before stopping playback from the active output `talk.event`.
const turnId = activeOutputTalkEvent.talkEvent.turnId;
await gateway.request("talk.session.cancelOutput", { sessionId, turnId, reason: "barge-in" });
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "working" },
  options: { willContinue: true },
});
await gateway.request("talk.session.submitToolResult", {
  sessionId,
  callId,
  result: { status: "already_delivered" },
  options: { suppressResponse: true },
});
await gateway.request("talk.session.submitToolResult", { sessionId, callId, result });
await gateway.request("talk.session.close", { sessionId });

// Client-owned provider session API.
await gateway.request("talk.client.create", {
  mode: "realtime",
  transport: "webrtc",
  brain: "agent-consult",
  sessionKey: "main",
});
await gateway.request("talk.client.toolCall", { sessionKey, callId, name, args });
await gateway.request("talk.client.steer", { sessionKey, text, mode: "steer" });
```

Browser-owned WebRTC/provider-websocket sessions use `talk.client.create`,
because the browser owns provider negotiation and media transport while the
Gateway owns credentials, instructions, and tool policy. `talk.session.*` is
the common Gateway-managed surface for gateway-relay realtime, gateway-relay
transcription, and managed-room native STT/TTS sessions.

Legacy configs that place realtime selectors beside `talk.provider` /
`talk.providers` should be repaired with `openclaw doctor --fix`; runtime Talk
does not reinterpret speech/TTS provider config as realtime provider config.

The supported `talk.session.create` combinations are intentionally small:

| Mode            | Transport       | Brain           | Owner              | Notes                                                                                                              |
| --------------- | --------------- | --------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `realtime`      | `gateway-relay` | `agent-consult` | Gateway            | Full-duplex provider audio bridged through the Gateway; tool calls route through the agent-consult tool.           |
| `transcription` | `gateway-relay` | `none`          | Gateway            | Streaming STT only; callers send input audio and receive transcript events.                                        |
| `stt-tts`       | `managed-room`  | `agent-consult` | Native/client room | Push-to-talk and walkie-talkie style rooms where the client owns capture/playback and the Gateway owns turn state. |
| `stt-tts`       | `managed-room`  | `direct-tools`  | Native/client room | Admin-only room mode for trusted first-party surfaces that execute Gateway tool actions directly.                  |

Method map for readers migrating from the older `talk.realtime.*` /
`talk.transcription.*` / `talk.handoff.*` families (all removed):

| Old                              | New                                                  |
| -------------------------------- | ---------------------------------------------------- |
| `talk.realtime.session`          | `talk.client.create`                                 |
| `talk.realtime.toolCall`         | `talk.client.toolCall`                               |
| `talk.realtime.relayAudio`       | `talk.session.appendAudio`                           |
| `talk.realtime.relayCancel`      | `talk.session.cancelOutput`                          |
| `talk.realtime.relayToolResult`  | `talk.session.submitToolResult`                      |
| `talk.realtime.relayStop`        | `talk.session.close`                                 |
| `talk.transcription.session`     | `talk.session.create({ mode: "transcription" })`     |
| `talk.transcription.relayAudio`  | `talk.session.appendAudio`                           |
| `talk.transcription.relayCancel` | `talk.session.close`                                 |
| `talk.transcription.relayStop`   | `talk.session.close`                                 |
| `talk.handoff.create`            | `talk.session.create({ transport: "managed-room" })` |
| `talk.handoff.revoke`            | `talk.session.close`                                 |

The unified control vocabulary is also deliberately narrow:

| Method                          | Applies to                                              | Contract                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talk.session.appendAudio`      | `realtime/gateway-relay`, `transcription/gateway-relay` | Append a base64 PCM audio chunk to the provider session owned by the same Gateway connection.                                                                                                                             |
| `talk.session.cancelOutput`     | `realtime/gateway-relay`                                | Stop assistant audio output without necessarily ending the user turn.                                                                                                                                                     |
| `talk.session.submitToolResult` | `realtime/gateway-relay`                                | Complete a provider tool call after any asynchronous completion exposed by its bridge; pass `options.willContinue` for interim output or, when supported, `options.suppressResponse` to avoid another assistant response. |
| `talk.session.steer`            | agent-backed Talk sessions                              | Send spoken `status`, `steer`, `cancel`, or `followup` control to the active embedded run resolved from the Talk session.                                                                                                 |
| `talk.session.close`            | all unified sessions                                    | Stop relay sessions or revoke managed-room state, then forget the unified session id.                                                                                                                                     |

Do not introduce provider or platform special cases in core to make this work.
Core owns Talk session semantics. Provider plugins own vendor session setup.
Voice-call and Google Meet own telephony/meeting adapters. Browser and native
apps own device capture/playback UX.
