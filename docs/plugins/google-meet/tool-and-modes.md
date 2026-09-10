---
summary: "The google_meet tool actions, status fields, and agent versus bidi talk-back modes"
read_when:
  - You are calling the google_meet tool from an agent
  - You are reading Chrome session health from google_meet status
  - You are choosing between agent, bidi, and transcribe modes
title: "Google Meet tool and modes"
sidebarTitle: "Tool and modes"
---

Tool actions for agents, session status fields, and the agent and bidi talk-back modes. Part of the [Google Meet plugin](/plugins/google-meet) guide.

## Tool

Agents use the `google_meet` tool:

```json
{
  "action": "join",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "mode": "agent"
}
```

| `action`                | Purpose                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `join`                  | Join an explicit Meet URL                                                                         |
| `create`                | Create a space (and join by default); supports `accessType`/`entryPointAccess`                    |
| `status`                | List active sessions, or inspect one by `sessionId`                                               |
| `setup_status`          | Run the same checks as `googlemeet setup`                                                         |
| `resolve_space`         | Resolve a URL/code/`spaces/{id}` via `spaces.get`                                                 |
| `preflight`             | Validate OAuth + meeting resolution prerequisites                                                 |
| `latest`                | Find the latest conference record for a meeting                                                   |
| `calendar_events`       | Preview Calendar events with Meet links                                                           |
| `artifacts`             | List conference records and participant/recording/transcript/smart-note metadata                  |
| `attendance`            | List participants and participant sessions                                                        |
| `export`                | Write the artifacts/attendance/transcript/manifest bundle; set `"dryRun": true` for manifest-only |
| `recover_current_tab`   | Focus/inspect an existing Meet tab without opening a new one                                      |
| `transcript`            | Read the bounded caption transcript; `sinceIndex` resumes from the previous `nextIndex`           |
| `leave`                 | End a session (Chrome clicks Leave; closes only tabs it opened; Twilio hangs up)                  |
| `end_active_conference` | End the active Google Meet conference for an API-managed space                                    |
| `speak`                 | Make the realtime agent speak immediately, given `sessionId` and `message`                        |
| `test_speech`           | Create/reuse a session, trigger a known phrase, return Chrome health                              |
| `test_listen`           | Create/reuse an observe-only session, wait for caption/transcript movement                        |

`test_speech` always forces `mode: "agent"` or `"bidi"` and fails if asked to run in `mode: "transcribe"`, because observe-only sessions cannot emit speech. `speechOutputVerified` requires both fresh realtime output bytes and fresh non-silent audio returning on the bridge's microphone capture path during that output. A reused session's older output or loopback signal does not count, and sink-byte growth alone no longer reports verified speech.

For Chrome transports, `leave` keeps a reused user-owned tab open after clicking Meet's Leave call button. Tabs opened by OpenClaw are closed after departure.

Use `transport: "chrome"` when Chrome runs on the Gateway host, `transport: "chrome-node"` when it runs on a paired node. In both cases the model providers and `openclaw_agent_consult` run on the Gateway host, so model credentials stay there. Agent-mode logs include the resolved transcription provider/model at bridge startup and the TTS provider/model/voice/output format/sample rate after each synthesized reply. Raw `mode: "realtime"` is still accepted as a legacy compatibility alias for `mode: "agent"`, but it is no longer advertised in the tool's `mode` enum.

`create` with an API-backed room and explicit access policy:

```json
{
  "action": "create",
  "transport": "chrome-node",
  "mode": "agent",
  "accessType": "OPEN"
}
```

Ending a known room's active conference:

```json
{
  "action": "end_active_conference",
  "meeting": "https://meet.google.com/abc-defg-hij"
}
```

Listen-first validation before claiming a meeting is useful:

```json
{
  "action": "test_listen",
  "url": "https://meet.google.com/abc-defg-hij",
  "transport": "chrome-node",
  "timeoutMs": 30000
}
```

Speaking on demand:

```json
{
  "action": "speak",
  "sessionId": "meet_...",
  "message": "Say exactly: I'm here and listening."
}
```

`status` includes Chrome health when available:

| Field                                                          | Meaning                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inCall`                                                       | Chrome appears to be inside the Meet call                                                                              |
| `micMuted`                                                     | Best-effort Meet microphone state                                                                                      |
| `manualAction.reason` / `manualAction.message`                 | Browser profile needs manual login, Meet host admission, permissions, or browser-control repair before speech can work |
| `speechReady` / `speechBlockedReason` / `speechBlockedMessage` | Whether managed Chrome speech is allowed now; `speechReady: false` means OpenClaw did not send the intro/test phrase   |
| `providerConnected` / `realtimeReady`                          | Realtime voice bridge state                                                                                            |
| `lastInputAt` / `lastOutputAt`                                 | Last audio seen from/sent to the bridge                                                                                |
| `audioInputRouted` / `audioInputDeviceLabel`                   | Whether Meet's microphone is the verified native virtual-audio input                                                   |
| `audioOutputRouted` / `audioOutputDeviceLabel`                 | Whether the Meet tab's media output was actively routed to the native virtual-audio backend                            |
| `lastOutputLoopbackAt` / `outputLoopbackSignalBytes`           | Fresh output whose waveform fingerprint was correlated on the virtual microphone capture path                          |
| `lastOutputLoopbackCorrelation`                                | Correlation score tying the captured signal to the current assistant-output generation                                 |
| `outputGeneration` / `verifiedOutputGeneration`                | Monotonic ids; equality means the current output, rather than an older utterance, passed loopback proof                |
| `lastOutputLoopbackRms` / `lastOutputLoopbackPeak`             | Audio-energy diagnostics for the latest verified loopback capture chunk                                                |
| `lastSuppressedInputAt` / `suppressedInputBytes`               | Loopback input ignored while assistant playback is active                                                              |

## Agent and bidi modes

| Mode    | Who decides the answer        | Speech output path                     | Use when                                              |
| ------- | ----------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `agent` | The configured OpenClaw agent | Normal OpenClaw TTS runtime            | You want "my agent is in the meeting" behavior        |
| `bidi`  | The realtime voice model      | Realtime voice provider audio response | You want the lowest-latency conversational voice loop |

`agent` mode: the realtime transcription provider hears meeting audio, final participant transcripts route through the configured OpenClaw agent, and the answer is spoken through regular OpenClaw TTS. Nearby final-transcript fragments are coalesced before the consult so one spoken turn does not produce several stale partial answers; realtime input is suppressed while queued assistant audio is still playing, and recent assistant-like transcript echoes are ignored before the consult so BlackHole loopback does not make the agent answer its own speech.

`bidi` mode: the realtime voice model answers directly and can call `openclaw_agent_consult` for deeper reasoning, current information, or normal OpenClaw tools. The consult tool runs the regular OpenClaw agent behind the scenes with recent meeting transcript context and returns a concise spoken answer; in `agent` mode OpenClaw sends that answer directly to TTS, in `bidi` mode the realtime voice model can speak it back. It uses the same shared consult machinery as Voice Call.

By default consults run against the `main` agent; set `realtime.agentId` to point a Meet lane at a dedicated agent workspace, model defaults, tool policy, memory, and session history. Agent-mode consults use a per-meeting `agent:<id>:subagent:google-meet:<session>` session key so follow-up questions keep meeting context while inheriting normal agent policy. When an agent calls `google_meet` in agent mode, the consultant session forks the caller's current transcript before answering participant speech; the Meet session stays separate so meeting follow-ups do not mutate the caller transcript directly.

`realtime.toolPolicy` controls the consult run:

| Policy           | Behavior                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `safe-read-only` | Expose the consult tool; limit the regular agent to `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, `memory_get` |
| `owner`          | Expose the consult tool; let the regular agent use its normal tool policy                                                        |
| `none`           | Do not expose the consult tool to the realtime voice model                                                                       |

The consult session key is scoped per Meet session, so follow-up consult calls reuse prior consult context during the same meeting.

Force a spoken readiness check after Chrome has fully joined:

```bash
openclaw googlemeet speak meet_... "Say exactly: I'm here and listening."
```

Full join-and-speak smoke:

```bash
openclaw googlemeet test-speech https://meet.google.com/abc-defg-hij \
  --transport chrome-node \
  --message "Say exactly: I'm here and listening."
```
