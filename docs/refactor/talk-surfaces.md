---
summary: "Surface adapter plan for browser, native, walkie-talkie, telephony, and meeting Talk refactor work"
read_when:
  - Updating browser realtime Talk, native Talk, walkie-talkie handoff, Voice Call, or meeting voice code
  - Deciding whether a Talk behavior belongs in an adapter or shared runtime
title: "Talk surface mapping"
---

# Talk Surface Mapping

This maps product surfaces into [Talk refactor plan](/refactor/talk) primitives.

## Browser

WebRTC:

- call `talk.client.create`
- open provider media connection in browser
- forward provider tool calls through `talk.client.toolCall`
- receive provider audio through provider media/data channel

Provider WebSocket:

- call `talk.client.create`
- connect using constrained provider result
- keep provider-specific framing in the browser adapter
- forward tool calls through `talk.client.toolCall`

Gateway relay:

- call `talk.session.create`
- send PCM frames with `talk.session.appendAudio`
- listen only to `talk.event`
- submit tool results with `talk.session.submitToolResult`
- barge-in with `talk.session.cancelOutput`
- close with `talk.session.close`

## Native And Nodes

Native apps map local audio lifecycle into Talk primitives.

Native realtime:

- use `talk.client.create` when the app owns provider media
- use `talk.session.create` when Gateway owns provider relay

Native STT/TTS:

- use `talk.session.create({ mode: "stt-tts", transport: "managed-room" })`
- keep local STT and local TTS behind native adapters
- drive success path from Talk events
- keep history polling only as a degraded fallback if explicitly tested

Native push-to-talk:

- press maps to `talk.session.startTurn`
- release maps to `talk.session.endTurn`
- cancel maps to `talk.session.cancelTurn`
- node capture commands emit capture events
- failed start cleans capture state
- opening voice UI never mutates global Talk config

Trusted node command adapters may remain:

```ts
talk.ptt.start;
talk.ptt.stop;
talk.ptt.cancel;
talk.ptt.once;
```

## Walkie-Talkie

Walkie-talkie is managed-room Talk:

```ts
await gateway.request("talk.session.create", {
  mode: "stt-tts",
  transport: "managed-room",
  brain: "agent-consult",
  sessionKey,
});
```

Then:

- client joins with `talk.session.join`
- press calls `talk.session.startTurn`
- release calls `talk.session.endTurn`
- cancel calls `talk.session.cancelTurn`
- assistant speech emits `output.text.*` and `output.audio.*`
- replacement emits `session.replaced` to old owner
- close calls `talk.session.close`

Room state includes canonical session id, route/channel target, caller identity,
mode, transport, brain, provider, model, voice, locale, expiry, token hash,
active client id, active turn id, and replacement state.

Two simultaneous rooms must not share turn ids, transcripts, audio output, or
cancellation tokens.

## Telephony

Voice Call becomes a telephony adapter over Talk semantics.

Keep telephony-owned: Twilio/Plivo WebSocket contracts, stream ids, call ids,
G.711 u-law, marks, clear events, backpressure, phone call lifecycle, and inbound
speech detection quirks.

Move shared behavior to Talk: event envelope, turn ids, cancellation, agent
consult abort, tool policy, usage and latency metrics, and output state.

Telephony should emit `talk.event` for observability, even if phone media
remains plugin-owned.

## Meetings

Google Meet and future meeting integrations become meeting adapters over Talk
semantics.

Keep meeting-owned: meeting join/leave, participant identity, room permissions,
echo suppression, transcript context, and meeting-specific mute/deafen behavior.

Move shared behavior to Talk: turn lifecycle, transcript events, assistant output
events, tool policy, cancellation, and metrics.

Meeting adapters may run `transcription`, `stt-tts`, or `realtime` depending on
provider support.
