---
summary: "macOS Talk overlay behavior and the streamed realtime Gateway relay path"
read_when:
  - Using Talk on macOS
  - Enabling the realtime Gateway relay on a Mac
  - Diagnosing a realtime session that will not start
title: "Talk on macOS and the Gateway relay"
sidebarTitle: "macOS and Gateway relay"
---

## Behavior (macOS)

- Always-on overlay while Talk mode is enabled.
- **Listening &rarr; Thinking &rarr; Speaking** phase transitions.
- Phase notifications are best-effort: a failed update does not start the local Gateway or restart its tunnel. Starting Talk retains normal connection recovery.
- On a short pause (silence window), the current transcript is sent.
- Replies are written to WebChat (same as typing).
- **Interrupt on speech** (default on): if the user talks while the assistant is speaking, playback stops and the interruption timestamp is noted for the next prompt.

## Realtime Talk over the Gateway relay (macOS)

macOS defaults to the native path above: Apple Speech recognition, Gateway chat, and `talk.speak`
playback. It switches to a streamed realtime session only when `talk.realtime` selects all three
of these together:

| Key         | Required value  |
| ----------- | --------------- |
| `mode`      | `realtime`      |
| `transport` | `gateway-relay` |
| `brain`     | `agent-consult` |

Any other combination — including a partially set one — keeps the native path.

```json5
{
  talk: {
    realtime: {
      provider: "openai",
      providers: {
        openai: {
          model: "gpt-realtime-2.1",
          speakerVoice: "cedar",
        },
      },
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    },
  },
}
```

The Mac must also opt in locally with **Settings > Voice & Talk > Use realtime Gateway relay**.
This preference defaults off and stays on that Mac; Gateway config alone never activates the
streamed path. Keep `transport: "webrtc"` for browser or iOS client-owned sessions; macOS uses
the relay only when the config explicitly selects `gateway-relay`.

The Gateway must also advertise `gateway-relay` and `agent-consult` for the selected provider in
`talk.catalog`. Realtime requires macOS 26 or newer, matching Voice Wake; on older versions the
Talk and Voice Wake controls are unavailable.

On Apple clients, relay playback stays active until the device finishes the queued audio, not
until an estimated duration expires. Playback acknowledgments and microphone echo suppression
follow that completion; pause, barge-in, and cancellation can still stop playback earlier.

### When realtime cannot start

Talk never silently sits idle. If the relay fails to start — no Gateway route, rejected
credentials, or an unsupported model — the failure is logged, the overlay shows the reason, and
Talk falls back to the native speech path for that session.

Once a session is running, a dropped relay reconnects on a bounded retry schedule (roughly 0.5 s
then 2 s). If those attempts are exhausted, the overlay reports
`Realtime disconnected repeatedly — using native speech` and the next start bypasses realtime.
Losing the microphone mid-session closes the relay and takes the same route.

Relay output cancellation is turn-scoped. Clients copy the current `turnId` from the
`talk.event` audio envelope. Matching ids return `applied`, stale ids return `stale`, and
sessions without an active turn return `idle`. Older clients that omit `turnId` still cancel
the current turn:

```json
{
  "method": "talk.session.cancelOutput",
  "params": {
    "sessionId": "relay-session-id",
    "turnId": "turn-7",
    "reason": "barge-in"
  }
}
```
