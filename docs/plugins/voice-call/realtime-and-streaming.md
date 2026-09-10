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

Current runtime behavior:

- `realtime.enabled` is supported for Twilio and Telnyx.
- `realtime.provider` is optional. If unset, Voice Call selects the first configured realtime voice provider in provider priority order. Providers named in `realtime.providers` are discovered even when another provider is already active; plugin disablement and allow/deny rules still apply.
- Bundled realtime voice providers: Google Gemini Live (`google`) and OpenAI (`openai`), registered by their provider plugins.
- Provider-owned raw config lives under `realtime.providers.<providerId>`.
- Voice Call exposes the built-in `openclaw_end_call` realtime tool on every call. It takes no arguments or call ID; the active voice bridge binds it to the current call.
- Voice Call exposes the shared `openclaw_agent_consult` realtime tool by default. The realtime model can call it when the caller asks for deeper reasoning, current information, or normal OpenClaw tools.
- `realtime.consultPolicy` optionally adds guidance for when the realtime model should call `openclaw_agent_consult`.
- `realtime.agentContext.enabled` is default-off. When enabled, Voice Call injects a bounded agent identity and selected workspace-file capsule into the realtime provider instructions at session setup.
- `realtime.fastContext.enabled` is default-off. When enabled, Voice Call first searches indexed memory/session context for the consult question and returns authorized snippets to the realtime model within `realtime.fastContext.timeoutMs` before falling back to the full consult agent only if `realtime.fastContext.fallbackToConsult` is true. The active memory plugin authorizes session-transcript hits; plugins without that capability fail closed for session hits while ordinary memory hits remain available.
- If `realtime.provider` points at an unregistered provider, or no realtime voice provider is registered at all, Voice Call logs a warning and skips realtime media instead of failing the whole plugin.
- `inboundPolicy` must not be `"disabled"` when `realtime.enabled` is true; `validateProviderConfig` rejects that combination.
- Consult session keys reuse the stored call session when available, then fall back to the configured `sessionScope` (`per-phone` by default, `per-call` for isolated calls, or `main` for the configured agent's main session).

<Warning>
GPT-Live uses agent delegation instead of native function tools. Its current
Voice Call bridge cannot invoke `openclaw_end_call` or custom `realtime.tools`.
Use an OpenAI GA realtime model or Google Gemini Live when the call needs those
controls; selecting GPT-Live does not make them available through delegation.
</Warning>

### Hangup detection

Realtime calls normally end when the carrier sends a stream stop event or closes
the media WebSocket. If an intermediary does not promptly forward that close,
OpenClaw treats 30 seconds without inbound media as a disconnect, waits a
2-second grace period for media to resume, and then ends the call.

If the realtime provider ends its session first, OpenClaw also ends the carrier
call, including when the provider reports a normal close. This prevents a silent
phone connection from remaining open after its voice session has finished.

The realtime model can also call `openclaw_end_call` when the caller asks to
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
`openclaw_end_call`:

| Policy           | Behavior                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `safe-read-only` | Expose the consult tool and limit the regular agent to `read`, `web_search`, `web_fetch`, `x_search`, `memory_search`, and `memory_get`. |
| `owner`          | Expose the consult tool and let the regular agent use the normal agent tool policy.                                                      |
| `none`           | Do not expose the consult tool. The built-in end-call tool and custom `realtime.tools` remain available.                                 |

`realtime.consultPolicy` controls only the realtime model instructions:

| Policy        | Guidance                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `auto`        | Keep the default prompt and let the provider decide when to call the consult tool.              |
| `substantive` | Answer simple conversational glue directly and consult before facts, memory, tools, or context. |
| `always`      | Consult before every substantive answer.                                                        |

When a host tool run reports cancellation, the realtime model receives a
cancelled result and the phone call stays open. Timeouts and other tool failures
remain errors; ending the phone session suppresses pending consult results.

### Agent voice context

Enable `realtime.agentContext` when the voice bridge should sound like the
configured OpenClaw agent without paying a full agent-consult round trip on
ordinary turns. The context capsule is added once when the realtime session
is created, so it does not add per-turn latency. Calls to
`openclaw_agent_consult` still run the full OpenClaw agent and should be used
for tool work, current information, memory lookups, or workspace state.

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

Current runtime behavior:

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
