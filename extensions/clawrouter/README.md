# ClawRouter

Managed multi-provider model routing and quota reporting for OpenClaw.

When `models.providers.clawrouter` is configured, the bundled plugin adds
**ClawRouter** to the Control UI sidebar. Its read-only pool dashboard shows
subscription quota windows, account and plan details, model eligibility,
extra usage, and traffic behind the configured key. **Refresh** fetches a new
snapshot. The ClawRouter policy must opt in to pool status visibility.

The plugin owns both the native browser bundle and the `clawrouter.pool.get`
Gateway method (`operator.read`). Credentials remain on the Gateway. Older
ClawRouter deployments, hidden policies, and unavailable or rejected credentials
show actionable status messages. The existing usage snapshot is unchanged.

See the [ClawRouter provider docs](https://docs.openclaw.ai/providers/clawrouter#pool-dashboard).

## Speech

The native speech provider uses ClawRouter's binary `/v1/audio/speech` route,
not the conversational Responses API. Select the qualified voice model
`clawrouter/openai/tts-1` through `agents.defaults.voiceModel` or set
`tts.provider: "clawrouter"`. Speech-only catalog rows stay out of chat models.

Credentials resolve as **ClawRouter** auth for the `audio.speech` capability:
stored ClawRouter profiles, `models.providers.clawrouter.apiKey`,
`CLAWROUTER_API_KEY`, or an explicit `tts.providers.clawrouter.apiKey`.
An optional `tts.providers.clawrouter.profileId` locks selection to that stored
profile; missing, unavailable, or wrong-provider profiles fail without substituting
another key. An OpenAI key is never borrowed. The service still authorizes every
request against the selected key's current speech grants and budget; discovering
a model or finding a credential is not a grant.

`tts.providers.clawrouter` accepts `model` (`openai/tts-1`), `voice`
(`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`), `speed` (0.25–4),
and `responseFormat` (`mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`).
The default is MP3 for files and Opus for voice notes. Telephony always requests
signed 16-bit mono PCM at 24 kHz for the existing call transport conversion.
Input is limited to 4096 Unicode code points. Newer instruction-based TTS,
transcription, and realtime sessions are not advertised by this adapter.

Talk uses `talk.provider: "clawrouter"` with the same credentials and format
settings under `talk.providers.clawrouter`; use `modelId: "openai/tts-1"` and
`speakerVoiceId` for its model and voice selections. Synthesis uses the normal
TTS request timeout and generated-audio size limit and returns service failures
rather than treating JSON error bodies as audio.

## Audio transcription

For batch/file transcription (including Talk file transcription), select
ClawRouter in the normal media configuration:

```json5
{
  tools: {
    media: {
      models: [{ provider: "clawrouter", model: "gpt-4o-transcribe", capabilities: ["audio"] }],
      audio: { enabled: true },
    },
  },
}
```

The adapter uses the configured ClawRouter origin and its native OpenAI
`/v1/native/openai/v1/audio/transcriptions` route. A base URL already ending in
that native `/v1` prefix is preserved. The configured model stays exactly
`gpt-4o-transcribe` (the qualified `openai/gpt-4o-transcribe` identity is also
accepted); no chat, Whisper, or upstream-key fallback is attempted. Credentials
come from canonical ClawRouter credential resolution. An entry’s `profile` locks
the selected ClawRouter profile. Custom transport, proxy, TLS, and private-network
policy remain governed by the shared HTTP transport.

Only nonstream JSON transcripts with optional language and prompt are supported.
Additional `providerOptions` fail explicitly rather than being silently dropped.
The normal media owner classifies MIME and trims prompt whitespace; the adapter
then preserves its file bytes, filename, effective MIME, language, and prompt.
AAC relabeling and unsafe filenames are rejected. File uploads are capped at
25,000,000 bytes; configured media byte/output limits can be lower.

An active or configured ClawRouter provider is also eligible for the existing
automatic audio selection. This is not an explicit-only adapter. Capability-less
shared chat/image entries do not opt into audio: use explicit audio capabilities
for shared transcription entries. Configured image-capable models retain
automatic, explicit, and shared image selection; native vision handoff is unchanged.
Authentication and configuration rejections can continue to another automatic
candidate before upload; missing credentials do not record a failed ClawRouter
attempt. An upload or HTTP failure stops automatic selection rather than sending
the same recording to another provider. In particular, a service `pricing_required`
response is not a reason to try a second provider.

A current service deployment with transcription support is required. Credential
availability does not prove per-key entitlement or budget admission. There is no
qualified whole-upload reserve ceiling for arbitrary files: hard-reserve requests
can return `pricing_required` before upstream dispatch. This adapter never changes
a policy to soft, fixed-price, or unmetered mode to make a request pass. Streaming,
diarization, other response formats/models, and realtime transcription remain
outside this adapter.
