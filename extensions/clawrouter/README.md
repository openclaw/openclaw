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
