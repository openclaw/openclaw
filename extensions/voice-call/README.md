# @openclaw/voice-call

Official Voice Call plugin for **OpenClaw**.

Providers:

- **Twilio** (Programmable Voice + Media Streams)
- **Telnyx** (Call Control v2)
- **Plivo** (Voice API + XML transfer + GetInput speech)
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
  provider: "twilio", // or "telnyx" | "plivo" | "mock"
  fromNumber: "+15550001234",
  toNumber: "+15550005678",
  sessionScope: "per-phone", // or "per-call" | "main"

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
  // tailscale: { mode: "funnel", port: 8443, path: "/voice/webhook" }

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

Notes:

- Twilio/Telnyx/Plivo require a **publicly reachable** webhook URL.
- `tailscale.port` defaults to `443` and owns the external HTTPS port for both legacy `tailscale.mode` and unified Tailscale tunnel providers. Funnel supports `443`, `8443`, or `10000`; Serve accepts any valid TCP port.
- Twilio defaults to US1. For a non-US Region, set `twilio.region` to `ie1` or `au1` and use credentials created in that Region; see [Twilio's regional REST API guide](https://www.twilio.com/docs/global-infrastructure/using-the-twilio-rest-api-in-a-non-us-region).
- `mock` is a local dev provider (no network calls).
- Telnyx requires `telnyx.publicKey` (or `TELNYX_PUBLIC_KEY`) unless `skipSignatureVerification` is true.
- Runtime accepts canonical config only. Doctor retains migrations for `provider: "log"`, `twilio.from`, legacy `streaming.*` OpenAI keys, and `realtime.agentContext.includeSystemPrompt` because supported releases can still preserve these settings. Run `openclaw doctor --fix` to normalize them; existing canonical values are preserved.
- advanced webhook, streaming, and tunnel notes: `https://docs.openclaw.ai/plugins/voice-call`
- `responseModel` is optional. When unset, voice responses use the runtime default model.
- `sessionScope` defaults to `per-phone`, preserving caller memory across calls. Use `per-call` for reception, booking, IVR, and bridge flows where each carrier call should start fresh. Use `main` to share the configured agent's main session (`agent:<agentId>:main`, or `global` when core `session.scope` is `"global"`). Custom core `session.mainKey` values are ignored.
- `realtime.consultThinkingLevel` is optional. When set, it overrides the thinking level used by the model behind realtime `openclaw_agent_consult` calls.
- `realtime.consultFastMode` is optional. When set, it toggles fast mode for realtime `openclaw_agent_consult` calls.
- `realtime.idleHangupMs` is optional. When set to a positive integer, an active realtime call ends after neither side has spoken for that many milliseconds; in-flight agent consults pause the timer. Unset keeps the current no-speech-idle-limit behavior.

## Per-call briefs and errands

`initiate_call` and `voicecall.initiate` accept an optional `brief`. The opening
`message` remains the first verbatim line; the brief guides the conversation
after it. The realtime voice and its consult agent receive the same brief.

All brief fields are optional:

| Field                | Value                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`               | Plain text describing what to achieve, up to 2000 characters.                                                                                                                      |
| `context`            | Facts the voice may use, up to 4000 characters.                                                                                                                                    |
| `language`           | Language name or BCP-47 tag, up to 100 characters.                                                                                                                                 |
| `identity`           | Introduction text, or `{ introduction, disclose: "volunteer" \| "when-asked" }`; up to 500 characters. Defaults to introducing only when asked.                                    |
| `disclosures`        | Up to 20 strings listing permitted personal details, each up to 500 characters. Defaults to none beyond the permitted identity.                                                    |
| `approvals`          | What the voice may agree to, up to 2000 characters. Defaults to no spending or commitments beyond the task.                                                                        |
| `voicemailMessage`   | Message to leave on a machine, up to 1000 characters. Defaults to the supplied introduction or a neutral message, followed by a promise to try again later; excludes task details. |
| `successCriteria`    | What counts as done, up to 1000 characters.                                                                                                                                        |
| `maxDurationSeconds` | Positive integer that shortens this call's duration limit; values above the configured cap are capped.                                                                             |

Briefs have an overall limit of 8000 JSON characters. Unknown fields are rejected.
For a plumber visit:

```json
{
  "action": "initiate_call",
  "to": "+15550005678",
  "mode": "conversation",
  "message": "Hello, can I arrange a plumber visit?",
  "brief": {
    "task": "Book a plumber to repair a leaking kitchen tap",
    "context": "The owner is available Tuesday or Thursday, 9 AM to noon. Ask for the callout fee before agreeing.",
    "language": "en",
    "identity": {
      "introduction": "I am calling on behalf of Alex",
      "disclose": "volunteer"
    },
    "disclosures": ["The owner's first name is Alex"],
    "approvals": "A visit on Tuesday or Thursday morning with a callout fee up to 20 EUR. No repair charges are approved.",
    "successCriteria": "Confirm the day, arrival window, callout fee and booking reference",
    "voicemailMessage": "Hello, I am calling to ask about a plumber visit for a leaking tap. The owner will follow up.",
    "maxDurationSeconds": 180
  }
}
```

CLI callers can pass `--brief 'Ask whether a plumber is available Tuesday'`,
`--brief '<JSON>'`, or `--brief-file ./plumber-brief.json`. The two brief flags
are mutually exclusive. Use `--mode conversation` for a conversation.

## Reports, live transcript, callbacks and voicemail

These features are disabled by default. Configure them under
`plugins.entries.voice-call.config`:

```json5
{
  reports: {
    enabled: true,
    includeTranscript: true, // default true
    // summaryModel: "<provider>/<model>",
    // inboundSessionKey: "agent:reception:main",
  },
  live: { transcript: true, minIntervalMs: 5000 },
  inboundPolicy: "allowlist",
  callbacks: {
    enabled: true,
    windowMinutes: 60,
    // greeting: "Hello, I can take a message for the owner.",
    // brief: { task: "Take a message for the owner" },
  },
  voicemail: { detection: "twilio", onMachine: "leave-message" },
}
```

- Reports go to the session that requested an outbound call. They include its
  outcome, important facts, duration, end reason and, by default, transcript.
  `reports.inboundSessionKey` selects the destination for ordinary inbound calls.
  A Gateway restart marks an interrupted pending report or live-transcript delivery
  as failed. OpenClaw does not resend it because the earlier process may already
  have reached the channel.
- Live transcript sends both sides' final lines to the requester in batches,
  at most once per `live.minIntervalMs` (default 5000).
  Each batch's position is saved before it is sent, so a call that survives a
  restart continues with new lines only and never repeats an earlier batch.
- With realtime voice enabled and `inboundPolicy: "allowlist"`, callbacks from a
  number called within `callbacks.windowMinutes` (default 60) are also accepted.
  They are linked to the original outbound call and take a message for the owner
  without sharing details. The classic STT/TTS path never admits callbacks. Other
  numbers follow the existing inbound policy. `callbacks.greeting` and
  `callbacks.brief` can customize that conversation.
- With Twilio machine detection, outbound conversation calls hold realtime input
  and the opening until a human or unknown result, or 30 seconds after the bridge
  is ready. A machine result blocks realtime speech even after that cap.
- Twilio machine detection leaves the brief's voicemail message once, waits for
  realtime voice playback to finish, and then hangs up. When realtime playback
  is unavailable, it retires the realtime stream and uses carrier text-to-speech
  followed by hang-up. With `onMachine: "hang-up"`, it ends the call immediately.
  Notify calls wait for detection before playing the appropriate message.
  The detected answer type is recorded. The mock provider can simulate this; Telnyx and Plivo behavior
  is unchanged. `voicemail.detection` defaults to `"off"`.

During a call, `steer_call` or `voicecall.steer` accepts `{ callId, message, mode }`.
`mode: "guidance"` (the default) changes the voice's guidance and subsequent consults;
`mode: "say"` makes the voice say the message verbatim now. Messages are limited
to 500 characters. Only the requesting session or an operator may steer that call.

```bash
openclaw voicecall steer --call-id <id> --message "Ask for the callout fee" --mode guidance
openclaw voicecall steer --call-id <id> --message "The owner can also do Thursday morning." --mode say
```

## Stale call reaper

See the plugin docs for recommended ranges and production examples:
`https://docs.openclaw.ai/plugins/voice-call#stale-call-reaper`

## TTS for calls

Voice Call uses the core `tts` configuration for
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

- `initiate_call` (message, to?, mode?, brief?)
- `steer_call` (callId, message, mode?: guidance | say)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

## Gateway RPC

- `voicecall.initiate` (to?, message, mode?, brief?)
- `voicecall.steer` (callId, message, mode?: guidance | say)
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
