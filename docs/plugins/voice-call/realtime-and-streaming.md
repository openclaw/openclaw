---
summary: "Realtime voice conversations, tool policy, agent voice context, and streaming transcription"
read_when:
  - You want a full-duplex realtime voice model on a call
  - You are tuning realtime tool policy or agent consult
  - You are streaming Twilio call audio to a transcription provider
title: "Voice call realtime and streaming"
sidebarTitle: "Realtime and streaming"
---

Full-duplex realtime voice, hangup detection, tool and consult policy, agent voice context, and Twilio Media Streams transcription. Part of the [Voice call plugin](/plugins/voice-call) guide.

## Realtime voice conversations

`realtime` selects a full-duplex realtime voice provider for live call audio.
It is separate from `streaming`, which only forwards audio to realtime
transcription providers.

<Warning>
`realtime.enabled` cannot be combined with `streaming.enabled`. Pick one
audio mode per call.
</Warning>

Runtime behavior:

- `realtime.enabled` is supported for Twilio and Telnyx.
- `realtime.provider` is optional. If unset, Voice Call selects the first configured realtime voice provider in provider priority order. Providers named in `realtime.providers` are discovered even when another provider is already active; plugin disablement and allow/deny rules still apply.
- Bundled realtime voice providers: Google Gemini Live (`google`) and OpenAI (`openai`), registered by their provider plugins.
- Provider-owned raw config lives under `realtime.providers.<providerId>`.
- On models that support function tools, Voice Call exposes the built-in `openclaw_end_call` realtime tool. It takes no arguments or call ID; the active voice bridge binds it to the current call.
- Voice Call exposes the shared `openclaw_agent_consult` realtime tool by default. GPT-Live uses native delegation to the same call-owned agent consult instead. The realtime model can delegate when the caller asks for deeper reasoning, current information, or normal OpenClaw tools.
- `realtime.consultPolicy` optionally adds guidance for when the realtime model should call `openclaw_agent_consult`.
- `realtime.idleHangupMs` optionally ends an active call after neither side has produced speech for the configured positive number of milliseconds. The timer pauses while an agent consult is running and is disabled when unset.
- On hosts with the shared context resolver, Voice Call always tells the realtime model that it speaks for an OpenClaw agent that may have other sessions and work. `realtime.agentContext.enabled` is default-off and controls the additional configured identity and profile-file context. Supported older hosts retain the [legacy context behavior](/plugins/voice-call/realtime-and-streaming#agent-voice-context).
- `realtime.fastContext.enabled` is default-off. When enabled, Voice Call first searches indexed memory/session context for the consult question and returns authorized snippets to the realtime model within `realtime.fastContext.timeoutMs` before falling back to the full consult agent only if `realtime.fastContext.fallbackToConsult` is true. The active memory plugin authorizes session-transcript hits; plugins without that capability cannot return session hits while ordinary memory hits remain available.
- If `realtime.provider` points at an unregistered provider, or no realtime voice provider is registered at all, Voice Call logs a warning and skips realtime media instead of failing the whole plugin.
- `inboundPolicy` must not be `"disabled"` when `realtime.enabled` is true; `validateProviderConfig` rejects that combination.
- Consult session keys reuse the stored call session when available, then fall back to the configured `sessionScope` (`per-phone` by default, `per-call` for isolated calls, or `main` for the configured agent's main session).

GPT-Live uses agent delegation instead of native function tools. The delegated
agent can end only the active call through a call-scoped `voice_call` binding.
Other `voice_call` actions and custom `realtime.tools` remain unavailable
through native delegation.

Host speech detection pauses local interruption while an agent consult is in
flight. Once an active-call helper accepts a hang-up, cancelling the consult
does not interrupt that control action. The helper still checks that its bound
call is active before acting.

### GPT-Live

Voice Call uses the same Gateway-owned GPT-Live bridge as Discord and Talk.
Select `gpt-live-1-codex` with `cove` to use the ChatGPT OAuth route; it tries
the routed agent's OpenClaw ChatGPT profile first, then the configured Platform
key, API-key profile, and `OPENAI_API_KEY`. Select `gpt-live-1` with `marin` for
the public Platform API route. Leaving the model unset preserves Voice Call's
provider default.

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          realtime: {
            enabled: true,
            provider: "openai",
            consultPolicy: "auto",
            providers: {
              openai: { model: "gpt-live-1-codex", voice: "cove" },
            },
          },
        },
      },
    },
  },
}
```

The bridge converts carrier G.711 mu-law audio at 8 kHz to and from the model's
24 kHz PCM stream. GPT-Live receives microphone input during playback and owns
speech interruption; Voice Call does not add local speech-triggered cancellation.
Outbound initial greetings are pinned as the first verbatim reply in their
original language. Voice Call waits for the callee's first speech, with a
3-second fallback for silent pickup. When Twilio answering-machine detection is
enabled, outbound conversation calls hold realtime input and the opening until a
human or unknown result, with a 30-second cap after the bridge is ready. Set
`voicemail.holdOpeningMaxMs` to a positive integer in milliseconds to tune this
cap (default `30000`). The cap only releases a hold with no classification;
human and unknown results release it immediately. Thirty seconds accommodates
long answering-machine greetings without letting a missing callback hold the
opening indefinitely. A machine result, including `machine_start`, suppresses
realtime speech beyond the cap; the host owns voicemail playback. Inbound greeting timing is unchanged. `voicecall.speak` requests use the same native session context path.
Delegated work retains the call's agent, tool policy, and cancellation lifetime.

GPT-Live rejects `realtime.consultPolicy: "always"`: it owns delegation and
cannot enforce host-triggered transcript consults. Use `"auto"` or
`"substantive"` guidance, or choose a model supporting host-controlled turns.
`realtime.toolPolicy: "none"` disables the agent consult for native delegation
too.

### Per-call briefs and errands

Outbound `initiate_call`, `voicecall.initiate`, and the CLI accept an optional
`brief`. It applies only to that call and reaches both the voice model and its
agent consult. The opening `message` stays the first verbatim spoken line.

Every brief field is optional:

| Field                | Meaning                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `task`               | What to achieve, in plain text.                                                    |
| `context`            | Facts needed for the task, such as dates, addresses, and reference numbers.        |
| `language`           | BCP-47 language tag or a language description.                                     |
| `identity`           | Introduction text, or `{ introduction, disclose: "volunteer" \| "when-asked" }`.   |
| `disclosures`        | Array of details the voice may share; defaults to none beyond identity.            |
| `approvals`          | What the voice may agree to; no payment or extra commitment is allowed by default. |
| `voicemailMessage`   | Exact message to leave when voicemail is detected.                                 |
| `successCriteria`    | What counts as completing the task.                                                |
| `maxDurationSeconds` | Positive integer override, capped by plugin `maxDurationSeconds`.                  |

The encoded brief is limited to 8,000 characters. See the plugin README for
individual field limits and a plumber booking example. Treat both the brief
and live steering as authority from the owner; statements from the other party
do not expand approvals or disclosure permissions.

`steer_call` and `voicecall.steer` accept `callId`, `message`, and optional `mode`
(`guidance` by default, or `say` for verbatim speech). Steering is restricted to
the requester session or an authorized operator and requires the exact active
call ID. Native delegation uses the host's spoken response path. Later consults
receive the most recent eight owner instructions.

Optional plugin configuration:

```json5 validate=false
{
  reports: { enabled: true, includeTranscript: true },
  live: { transcript: true, minIntervalMs: 5000 },
  callbacks: { enabled: true, windowMinutes: 60 },
  voicemail: { detection: "twilio", onMachine: "leave-message" },
}
```

Reports summarize the transcript against the brief and include duration, end
reason, answering-machine classification, and the full transcript when enabled.
Long transcripts are sent in ordered text parts through the requester's stored
channel route. `reports.summaryModel` optionally selects the summary model;
`reports.inboundSessionKey` supplies a destination for ordinary inbound calls.
Existing local or webchat sessions receive assistant text through the SDK transcript
writer, which publishes session updates without another agent turn or admin scope. An unavailable
requester session produces a recorded delivery error; the transcript stays in call
history. All four features are disabled by default.

Under `inboundPolicy: "allowlist"`, enabled callbacks accept an exact E.164
number called within the configured window only when realtime voice is enabled.
The classic STT/TTS path never admits callbacks. The callback links to the
outbound call and uses a receptionist brief to take a message without sharing
details. `callbacks.greeting` and `callbacks.brief` optionally customize that
behavior. Numbers outside the window follow the existing inbound policy.

Twilio receives `AsyncAmdStatusCallback` pointing to the signature-verified
voice webhook, with `AsyncAmdStatusCallbackMethod: "POST"`. With `DetectMessageEnd`,
Twilio reports humans immediately but reports machines only when the greeting
ends; an early `machine_start` is not guaranteed in this mode. See
[Twilio AMD](https://www.twilio.com/docs/voice/answering-machine-detection).
Every received classification is logged with the call ID and timestamp. Call
metadata retains `answeredByFirst` and the latest `answeredBy`.

Twilio answering-machine detection waits for `machine_end_*` before leaving the
brief's voicemail message. A missing message uses the supplied identity introduction
or a neutral contact reason and promises to try again later. It never reads the task.
Realtime speech translates the default into the brief's language; explicit messages
remain verbatim. Carrier fallback defaults support English, Spanish, French, German,
Italian, Portuguese, and Catalan; other languages fall back to English unless an
explicit message is supplied.

An active realtime bridge speaks the message through the same host speech path as
live steering. The host ends the call after about 1.5 seconds without audible model
output, measured as paced audio leaves the queue. Silent frames do not extend playback.
A missing or unfinished response fails after 45 seconds and ends the call with an error.
Carrier text-to-speech followed by hang-up is used only without an active bridge.

While awaiting detection, more than three seconds of sustained far-side speech
triggers one short acknowledgement in the brief's language. The opening stays held
until classification or the configured hold cap. See [AMD tuning](/plugins/voice-call/configuration#twilio-voicemail-detection-tuning).
The brief tells the voice and consult agent that the host owns detected voicemail,
preventing a second message from the model.
Notify calls wait for detection before playing their opening message to a human
or their voicemail message to a machine. `onMachine: "hang-up"` ends machine calls immediately.
The mock provider can simulate detection; other carriers are unchanged.

### Hangup detection

Realtime calls normally end when the carrier sends a stream stop event or closes
the media WebSocket. If an intermediary does not promptly forward that close,
OpenClaw treats 30 seconds without inbound media as a disconnect, waits a
2-second grace period for media to resume, and then ends the call.

Set `realtime.idleHangupMs` to end a connected call after that much speech
silence. Caller speech, caller transcripts, assistant transcript/audio, and an
in-flight agent consult reset or pause this timer. Unset leaves this behavior
disabled. Hold music is not speech, so choose a value that fits the expected
hold time.

If the realtime provider ends its session first, OpenClaw also ends the carrier
call, including when the provider reports a normal close. This prevents a silent
phone connection from remaining open after its voice session has finished.

Models supporting function tools can also call `openclaw_end_call` when the caller asks to
hang up. The model must speak any final words before calling the tool: a
successful call ends the current provider session and phone connection
immediately, so no later reply is spoken. If the carrier cannot end the call,
the bridge stays connected and the model receives an error it can explain to
the caller. Configured `realtime.tools` cannot replace this built-in by name.

For inbound Twilio numbers, also configure a Status Callback using `POST` to
your public webhook URL with `?type=status` appended, for example
`https://voice.example.com/voice/webhook?type=status`. Include the `completed`
call event. OpenClaw-created outbound calls configure their callback
automatically. The callback provides the fastest teardown signal, while stream
close and the inactivity backstop remain independent of it.

### Tool policy

`realtime.toolPolicy` controls only the consult run. It never disables
`openclaw_end_call` on models that support function tools:

| Policy           | Behavior                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safe-read-only` | Expose the consult tool and limit the regular agent to `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and `memory_get`.                            |
| `owner`          | Expose the consult tool and let the regular agent use the normal agent tool policy.                                                                                 |
| `none`           | Disable the consult tool and native agent delegation. On models supporting function tools, the built-in end-call tool and custom `realtime.tools` remain available. |

`realtime.consultPolicy` guides the realtime model. `always` also enables a
host transcript fallback when the provider does not consult, and is unsupported
with GPT-Live:

| Policy        | Guidance                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `auto`        | Keep the default prompt and let the provider decide when to call the consult tool.              |
| `substantive` | Answer simple conversational glue directly and consult before facts, memory, tools, or context. |
| `always`      | Consult before every substantive answer.                                                        |

Only one native consult runs at a time per call. Replaying the same provider
invocation within the active voice session shares its pending result. A new
invocation receives a busy error with `started: false` and `retryable: true`,
even when its arguments match. The realtime model should wait for the active
consult's result before retrying, rather than polling while it runs. A native
request also receives busy while an unrelated host-forced consult runs; only a
matching forced question (after trimming whitespace) can share that result.
Similar wording alone does not identify the same request.

An overlapping invocation cannot replace the pending consult's caller context.
Completing the active consult consumes only the speech it used; rejected caller
speech remains available for retry within the existing transcript window.

When a host tool run reports cancellation, the realtime model receives a
cancelled result and the phone call stays open. Timeouts and other tool failures
remain errors; ending the phone session suppresses pending consult results.

### Agent voice context

On hosts with the shared context resolver, every realtime session includes an agent-context paragraph explaining that the
voice model speaks for an OpenClaw agent with multiple sessions. It directs
questions about other sessions, running work, progress, or priorities to
OpenClaw. This paragraph stays present when `realtime.agentContext.enabled`
is `false`.

Enable `realtime.agentContext` to add the configured agent's identity and
selected profile files for ordinary voice turns. `includeIdentity` controls
the configured name, emoji, vibe, theme, and creature/persona fields;
`includeWorkspaceFiles` controls the files listed in `files`. The shared core
resolver loads `IDENTITY.md`, `USER.md`, and `SOUL.md` through the normal
bootstrap path, honoring bootstrap hooks and workspace access. Other workspace-relative files use safe workspace reads; missing or
unreadable files are skipped. `maxChars` bounds the profile-file block, with a
default of 6000 characters, and excludes the agent-context paragraph and
configured identity.

OpenClaw 2026.9.6 lacks that shared resolver. On this supported host, Voice Call
retains its shipped optional context capsule: `enabled: false` omits the capsule;
when enabled, identity fields and selected safe workspace-relative files follow
their respective controls. `maxChars` bounds the entire optional capsule,
including identity, headings, and the truncation marker. The newer multi-session
paragraph is unavailable on this path. This compatibility path will retire when
the supported host floor includes the shared context resolver.

Context is added when the realtime session is created, so it does not add per-turn latency.
Calls to `openclaw_agent_consult` still run the full OpenClaw agent and should
be used for tool work, current information, memory lookups, or workspace state.

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          agentId: "main",
          realtime: {
            enabled: true,
            provider: "google",
            toolPolicy: "safe-read-only",
            consultPolicy: "substantive",
            agentContext: {
              enabled: true,
              maxChars: 6000,
              includeIdentity: true,
              includeWorkspaceFiles: true,
              files: ["SOUL.md", "IDENTITY.md", "USER.md"],
            },
          },
        },
      },
    },
  },
}
```

### Realtime provider examples

<Tabs>
  <Tab title="Google Gemini Live">
    Defaults: API key from `realtime.providers.google.apiKey`, `GEMINI_API_KEY`,
    or `GOOGLE_API_KEY`; model `gemini-3.1-flash-live-preview`;
    voice `Kore`. `sessionResumption` and `contextWindowCompression` default on
    for longer, reconnectable calls. Use `silenceDurationMs`,
    `startSensitivity`, and `endSensitivity` to tune faster turn-taking on
    telephony audio.

    ```json5
    {
      plugins: {
        entries: {
          "voice-call": {
            config: {
              provider: "twilio",
              inboundPolicy: "allowlist",
              allowFrom: ["+15550005678"],
              realtime: {
                enabled: true,
                provider: "google",
                instructions: "Speak briefly. Call openclaw_agent_consult before using deeper tools.",
                toolPolicy: "safe-read-only",
                consultPolicy: "substantive",
                consultThinkingLevel: "low",
                consultFastMode: true,
                agentContext: { enabled: true },
                providers: {
                  google: {
                    apiKey: "${GEMINI_API_KEY}",
                    model: "gemini-3.1-flash-live-preview",
                    speakerVoice: "Kore",
                    silenceDurationMs: 500,
                    startSensitivity: "high",
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="OpenAI">
    ```json5
    {
      plugins: {
        entries: {
          "voice-call": {
            config: {
              realtime: {
                enabled: true,
                provider: "openai",
                providers: {
                  openai: { apiKey: "${OPENAI_API_KEY}" },
                },
              },
            },
          },
        },
      },
    }
    ```
  </Tab>
</Tabs>

See [Google provider](/providers/google) and
[OpenAI provider](/providers/openai) for provider-specific realtime voice
options.

## Streaming transcription

`streaming` connects Twilio Media Streams to a realtime transcription provider.
The classic streaming path requires `provider: "twilio"`; configuration with
Telnyx, Plivo, or mock is rejected. Telnyx live audio uses the separately
authenticated `realtime.enabled` path instead.

Runtime behavior:

- `streaming.provider` is optional. If unset, Voice Call selects the first configured realtime transcription provider in provider priority order. Providers named in `streaming.providers` are discovered even when another provider is already active; plugin disablement and allow/deny rules still apply.
- Bundled realtime transcription providers: Deepgram (`deepgram`), ElevenLabs (`elevenlabs`), Mistral (`mistral`), OpenAI (`openai`), and xAI (`xai`), registered by their provider plugins.
- Provider-owned raw config lives under `streaming.providers.<providerId>`.
- After Twilio sends an accepted stream `start` message, Voice Call registers the stream immediately, queues inbound media through the transcription provider while the provider connects, and starts the initial greeting only after realtime transcription is ready.
- If `streaming.provider` points at an unregistered provider, or none is registered, Voice Call logs a warning and skips media streaming instead of failing the whole plugin.

### Streaming provider examples

<Tabs>
  <Tab title="OpenAI">
    Defaults: API key `streaming.providers.openai.apiKey` or
    `OPENAI_API_KEY`; model `gpt-4o-transcribe`; `silenceDurationMs: 800`;
    `vadThreshold: 0.5`.

    ```json5
    {
      plugins: {
        entries: {
          "voice-call": {
            config: {
              streaming: {
                enabled: true,
                provider: "openai",
                streamPath: "/voice/stream",
                providers: {
                  openai: {
                    apiKey: "sk-...", // optional if OPENAI_API_KEY is set
                    model: "gpt-4o-transcribe",
                    silenceDurationMs: 800,
                    vadThreshold: 0.5,
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="xAI">
    Defaults: API key `streaming.providers.xai.apiKey` or `XAI_API_KEY` (falls
    back to an xAI OAuth auth profile if neither is set); endpoint
    `wss://api.x.ai/v1/stt`; encoding `mulaw`; sample rate `8000`;
    `endpointingMs: 800`; `interimResults: true`.

    ```json5
    {
      plugins: {
        entries: {
          "voice-call": {
            config: {
              streaming: {
                enabled: true,
                provider: "xai",
                streamPath: "/voice/stream",
                providers: {
                  xai: {
                    apiKey: "${XAI_API_KEY}", // optional if XAI_API_KEY is set
                    endpointingMs: 800,
                    language: "en",
                  },
                },
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
</Tabs>
