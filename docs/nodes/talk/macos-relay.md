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

### Spoken stop phrases (macOS)

To end Talk without clicking the overlay, say **stop talking** or **end talking**.
The Mac turns off Talk Mode, stops capture and playback, and plays a short
confirmation sound, even when Talk phase sounds are disabled. If you do not hear
the sound, check that Talk Mode is off; silence does not confirm a successful stop.

**Dashboard → Settings → Talk → This Mac → Spoken exit acknowledgement** is off
by default. Enable it to add response instructions on compatible OpenAI
`gpt-realtime-2.1` Gateway relays, asking the assistant to acknowledge a standalone stop command with a brief “Okay.” in its
current voice. The Mac stops microphone delivery immediately and allows up to
1.2 seconds of suitable acknowledgement audio to finish before the same
confirmation sound. A two-second failure deadline keeps shutdown from hanging;
unrecognized, long, or missing acknowledgements use the existing sound alone.
This is best effort: speech and transcripts can arrive out of order, so the
acknowledgement may be clipped or omitted. The final local stop-phrase matcher
still decides whether Talk turns off; the model cannot disable it.

Turning this setting off omits those response instructions and immediately uses
the existing shutdown and confirmation sound. Stop phrases and transcription
hints still work. This preference is local to the Mac; it does not change Gateway
configuration or the voice selected for other clients.

Changing this setting or changing/resetting stop phrases during realtime Talk restarts that session
through the normal reconfiguration path so response guidance and recognition
context use the new list. Older Gateways, other models, and forced agent-consult
routes retain immediate shutdown and the existing confirmation sound.
Ending Talk does not disable Voice Wake: it resumes when enabled and available.
This works in native Talk and the realtime Gateway relay; it ends the local
conversation mode rather than asking the assistant to stay quiet.

In the Mac app, open **Dashboard → Settings → Talk → This Mac → Stop phrases**:

- The default list is `stop talking` and `end talking`.
- Enter one phrase per line. Your list replaces the defaults; use a phrase in any
  language your speech recognizer can transcribe reliably.
- Leave the field to save your changes on this Mac. Once saved, they apply to the
  next completed user utterance.
- Clear the field and leave it to save an empty list and disable spoken exit.
  Blank lines are ignored.
- Choose **Reset stop phrases** to restore the Mac's default list.

Matching uses the whole recognized utterance, ignoring case, repeated whitespace,
and trailing sentence punctuation (`.!?。！？`). A leading or trailing English
`please` is optional. Commands are evaluated when a user turn completes;
assistant-role transcript events are ignored. Surrounding words or quotation marks
must match an explicitly configured phrase.
For example, the default list matches “Please stop talking!” but not “Don't stop talking”.
Speech recognition still follows the selected native or realtime path; this setting
does not make transcription offline. Recognition and echo control can still miss
commands or misattribute residual speaker audio.

When a compatible Gateway advertises command-transcription hints for the OpenAI
`gpt-realtime-2.1` relay, the Mac includes its configured stop phrases as context
for input transcription. Hints are captured when the session starts; removing a
phrase still disables that local command immediately. An empty list, unsupported
Gateway, or invalid hint set leaves hints off. Hints accept up to eight phrases,
64 UTF-16 code units per phrase and 256 total, without surrounding whitespace,
control characters, or format characters; longer local phrases still work through
the ordinary matcher. Hints can improve recognition but do not guarantee it, and
never replace the final-user command checks above.

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

The Mac must also opt in locally with **Dashboard → Settings → Talk → This Mac → Use realtime Gateway relay**.
This preference defaults off and stays on that Mac; Gateway config alone never activates the
streamed path. Keep `transport: "webrtc"` for browser or iOS client-owned sessions; macOS uses
the relay only when the config explicitly selects `gateway-relay`.

The Gateway must also advertise `gateway-relay` and `agent-consult` for the selected provider in
`talk.catalog`. Realtime requires macOS 26 or newer, matching Voice Wake; on older versions the
Talk and Voice Wake controls are unavailable.

On Apple clients, relay playback stays active until the device finishes the queued audio, not
until an estimated duration expires. Streaming buffers refill as the device consumes them,
while playback acknowledgments wait for the final audible drain. Pause, barge-in, and
cancellation can still stop playback earlier.

Apple clients use the selected provider's `talk.catalog` capability to determine interruption
ownership. Continuous providers such as GPT Live keep microphone input open during playback
and own speech interruptions themselves. If catalog access is unavailable, Apple clients
leave speech interruption to the provider.

On macOS, realtime capture and playback share an audio engine. Software echo control uses
the rendered output as its reference, keeping the selected microphone available for spoken
interruption on speaker and multi-output routes. Realtime capture accepts an individually
selected input device, including its channels within an engine-created aggregate. Selecting
an aggregate itself as the microphone is unsupported because its channels can mix microphone
and loopback audio. This restriction does not prevent aggregate or multi-output playback.
If the app cannot identify the input channels or maintain the echo reference, it closes capture and uses
the normal reconnect or native-fallback path rather than bypassing realtime echo control.

Spoken interruption on speaker routes also depends on Gateway turn detection. When the
Gateway forces every utterance through agent consultation (`force-agent-consult`), it
disables server interruption, so that mode does not support speaker-route barge-in.
For turn-based providers, isolated headphones retain local speech interruption. Direct
WebRTC behavior is unchanged.

Explicitly stopping GPT Live output ends the voice session. Apple clients preserve that stop
instead of reconnecting automatically. On macOS, pausing keeps Talk paused; resuming starts a
fresh session if the provider closed the paused session. Ordinary connection failures still
use the recovery path below. Headphones can reduce residual speaker echo.

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
