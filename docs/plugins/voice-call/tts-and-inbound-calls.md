---
summary: "Telephony TTS, inbound policy, per-number routing, and call lifecycle timers"
read_when:
  - You are choosing the TTS voice used on calls
  - You are enabling inbound calls or per-number routing
  - You need to tune the stale call reaper or call duration caps
title: "Voice call TTS and inbound calls"
sidebarTitle: "TTS and inbound calls"
---

Telephony text-to-speech, inbound policy and per-number routing, the spoken output contract, conversation startup, and the stale call reaper. Part of the [Voice call plugin](/plugins/voice-call) guide.

## TTS for calls

Voice Call uses the core `tts` configuration for streaming speech on
calls. You can override it under the plugin config with the **same shape** —
it deep-merges with `tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
        modelId: "eleven_multilingual_v2",
      },
    },
  },
}
```

<Warning>
**Microsoft speech is ignored for voice calls.** Telephony synthesis requires
a provider that implements telephony-target output; the Microsoft speech
provider does not, so it is skipped for calls and other providers in the
fallback chain are tried instead.
</Warning>

Behavior notes:

- Legacy `tts.<provider>` keys inside plugin config (`openai`, `elevenlabs`, `microsoft`, `edge`) are repaired by `openclaw doctor --fix`; committed config should use `tts.providers.<provider>`.
- Core TTS is used when Twilio media streaming is enabled; otherwise calls fall back to provider-native voices.
- If a Twilio media stream is already active, Voice Call does not fall back to TwiML `<Say>`. If telephony TTS is unavailable in that state, the playback request fails instead of mixing two playback paths.
- When telephony TTS falls back to a secondary provider, Voice Call logs a warning with the provider chain (`from`, `to`, `attempts`) for debugging.
- When Twilio barge-in or stream teardown clears the pending TTS queue, queued playback requests settle instead of hanging callers awaiting playback completion.
- Resumed caller speech discards older automatic replies that are still being generated. Twilio streaming reacts to speech-start and partial transcripts; carrier webhook calls react when a new speech event arrives. Explicit speech requests remain available, and already accepted agent work can finish without speaking an obsolete reply.

### TTS examples

<Tabs>
  <Tab title="Core TTS only">
```json5
{
  tts: {
    provider: "openai",
    providers: {
      openai: { speakerVoice: "alloy" },
    },
  },
}
```
  </Tab>
  <Tab title="Override to ElevenLabs (calls only)">
```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            providers: {
              elevenlabs: {
                apiKey: "elevenlabs_key",
                speakerVoiceId: "pMsXgVXv3BLzUgSXRplE",
                modelId: "eleven_multilingual_v2",
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
  <Tab title="OpenAI model override (deep-merge)">
```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            providers: {
              openai: {
                model: "gpt-4o-mini-tts",
                speakerVoice: "marin",
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

## Inbound calls

Inbound policy defaults to `disabled`. To enable inbound calls, set:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

<Warning>
`inboundPolicy: "allowlist"` is a low-assurance caller-ID screen. The plugin
normalizes the provider-supplied `From` value and compares it to `allowFrom`.
Webhook verification authenticates provider delivery and payload integrity,
but it does **not** prove PSTN/VoIP caller-number ownership. Treat
`allowFrom` as caller-ID filtering, not strong caller identity.
</Warning>

Auto-responses use the agent system. Tune with `responseModel`,
`responseSystemPrompt`, and `responseTimeoutMs`.

### Per-number routing

Use `numbers` when one Voice Call plugin receives calls for multiple phone
numbers and each number should behave like a different line. For example,
one number can use a casual personal assistant while another uses a business
persona, a different response agent, and a different TTS voice.

Routes are selected from the provider-supplied dialed `To` number. Keys must
be E.164 numbers. When a call arrives, Voice Call resolves the matching
route once, stores the matched route on the call record, and reuses that
effective config for the greeting, classic auto-response path, realtime
consult path, and TTS playback. If no route matches, the global Voice Call
config is used. Outbound calls do not use `numbers`; pass the outbound
target, message, and session explicitly when initiating the call.

Route overrides currently support:

- `inboundGreeting`
- `tts`
- `agentId`
- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

The `tts` route value deep-merges over the global Voice Call `tts` config, so
you can usually override only the provider voice:

```json5
{
  inboundGreeting: "Hello from the main line.",
  responseSystemPrompt: "You are the default voice assistant.",
  tts: {
    provider: "openai",
    providers: {
      openai: { speakerVoice: "coral" },
    },
  },
  numbers: {
    "+15550001111": {
      inboundGreeting: "Silver Fox Cards, how can I help?",
      responseSystemPrompt: "You are a concise baseball card specialist.",
      tts: {
        providers: {
          openai: { speakerVoice: "alloy" },
        },
      },
    },
  },
}
```

### Spoken output contract

For auto-responses, Voice Call appends a strict spoken-output contract to
the system prompt requiring a `{"spoken":"..."}` JSON reply. Voice Call
extracts speech text defensively:

- Ignores payloads marked as reasoning/error content.
- Parses direct JSON, fenced JSON, or inline `"spoken"` keys.
- Falls back to plain text and removes likely planning/meta lead-in paragraphs.

This keeps spoken playback focused on caller-facing text and avoids leaking
planning text into audio.

### Conversation startup behavior

For outbound `conversation` calls, first-message handling is tied to live
playback state:

- Barge-in queue clear and auto-response are suppressed only while the initial greeting is actively speaking.
- If initial playback fails, the call returns to `listening` and the initial message remains queued for retry.
- Initial playback for Twilio streaming starts on stream connect without extra delay.
- Barge-in aborts active playback and clears queued-but-not-yet-playing Twilio TTS entries. Cleared entries resolve as skipped, so follow-up response logic can continue without waiting on audio that will never play.
- Realtime voice conversations use the realtime stream's own opening turn. Voice Call does **not** post a legacy `<Say>` TwiML update for that initial message, so outbound `<Connect><Stream>` sessions stay attached.

### Twilio stream disconnect grace

When a Twilio classic streaming or realtime media stream disconnects, Voice
Call waits **2000 ms** before auto-ending the call:

- If the stream reconnects during that window, auto-end is canceled.
- If no stream re-registers after the grace period, the call is ended to prevent stuck active calls.
- Realtime bridge/session resources, queued audio, transcript ownership, and in-flight consult work close immediately. Only call/provider finalization waits for reconnect.

## Stale call reaper

Use `staleCallReaperSeconds` (default **120**) to end calls that are never
answered and never reach a live conversation state, for example notify-mode
calls where the provider never delivers a terminal webhook. Set it to `0` to
disable.

The reaper runs every 30 seconds and only ends calls that have no
`answeredAt` timestamp and are not already in a terminal or live
(`speaking`/`listening`) state, so answered conversations are never reaped
by this timer; `maxDurationSeconds` (default 300) is the separate cap that
ends answered calls that run too long.

For notify-style flows where carriers can be slow to deliver ring/answer
webhooks, raise `staleCallReaperSeconds` past the default so slow-but-normal
calls are not reaped early; `120`-`300` seconds is a reasonable production
range.

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          maxDurationSeconds: 300,
          staleCallReaperSeconds: 120,
        },
      },
    },
  },
}
```
