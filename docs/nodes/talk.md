summary: "Talk mode: continuous speech conversations with configurable Talk TTS and macOS STT backends"
read_when:

- Implementing Talk mode on macOS/iOS/Android
- Changing voice/TTS/interrupt behavior
- Switching macOS Talk Mode between Apple Speech and ExecuTorch
  title: "Talk Mode"

---

# Talk Mode

Talk mode is a continuous voice conversation loop:

1. Listen for speech
2. Convert speech to text
3. Send transcript to the model (main session, `chat.send`)
4. Speak the reply

Current defaults:

- Speech recognition on macOS: Apple Speech
- Talk TTS config shape: `talk.provider` + `talk.providers`
- Current streaming playback path on Apple clients: ElevenLabs

## Behavior (macOS)

- **Always-on overlay** while Talk mode is enabled.
- **Listening → Thinking → Speaking** phase transitions.
- On a **short pause** (silence window), the current transcript is sent.
- Replies are **written to WebChat** (same as typing).
- **Interrupt on speech** (default on): if the user starts talking while the assistant is speaking, we stop playback and note the interruption timestamp for the next prompt.
- If the ExecuTorch STT backend is selected but fails to load or start, Talk Mode falls back to Apple Speech.

## STT backends (macOS)

Talk Mode speech recognition on macOS supports:

- `apple`: default Apple Speech recognition
- `executorch`: optional local Parakeet-TDT backend via the bundled ExecuTorch plugin

To switch the backend:

```bash
defaults write <bundle-id> openclaw.talkSttBackend executorch
```

Example for a dev app bundle:

```bash
defaults write ai.openclaw.mac.debug openclaw.talkSttBackend executorch
```

Then fully relaunch the app.

To switch back:

```bash
defaults write <bundle-id> openclaw.talkSttBackend apple
```

Notes:

- `executorch` currently requires macOS Apple Silicon and the setup from [ExecuTorch Plugin](/plugins/executorch).
- STT backend selection is separate from Talk TTS configuration under `talk`.
- Apple Speech remains the default when the backend key is unset.

## Voice directives in replies

The assistant may prefix its reply with a **single JSON line** to control voice:

```json
{ "voice": "<voice-id>", "once": true }
```

Rules:

- First non-empty line only.
- Unknown keys are ignored.
- `once: true` applies to the current reply only.
- Without `once`, the voice becomes the new default for Talk mode.
- The JSON line is stripped before TTS playback.

Supported keys:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        modelId: "eleven_v3",
        outputFormat: "pcm_44100",
        apiKey: "elevenlabs_api_key",
      },
    },
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

Defaults:

- `provider`: `elevenlabs` when legacy Talk fields are normalized into the current shape
- `interruptOnSpeech`: true
- `silenceTimeoutMs`: when unset, Talk keeps the platform default pause window before sending the transcript (`700 ms on macOS and Android, 900 ms on iOS`)
- `talk.providers.elevenlabs.voiceId`: falls back to `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (or the first ElevenLabs voice when an API key is available)
- `talk.providers.elevenlabs.modelId`: defaults to `eleven_v3` when unset
- `talk.providers.elevenlabs.apiKey`: falls back to `ELEVENLABS_API_KEY` (or gateway shell profile if available)
- `talk.providers.elevenlabs.outputFormat`: defaults to `pcm_44100` on macOS/iOS and `pcm_24000` on Android (set `mp3_*` to force MP3 streaming)

Legacy compatibility fields are still accepted:

- `talk.voiceId`
- `talk.voiceAliases`
- `talk.modelId`
- `talk.outputFormat`
- `talk.apiKey`

Those legacy fields normalize into `talk.provider: "elevenlabs"` plus
`talk.providers.elevenlabs.*`.

If you define multiple entries under `talk.providers`, set `talk.provider` to the
active provider id. On current Apple Talk clients, unsupported active providers
fall back to the system voice.

## macOS UI

- Menu bar toggle: **Talk**
- Config tab: **Talk Mode** group (voice id + interrupt toggle)
- Overlay:
  - **Listening**: cloud pulses with mic level
  - **Thinking**: sinking animation
  - **Speaking**: radiating rings
  - Click cloud: stop speaking
  - Click X: exit Talk mode

## Notes

- Requires Speech + Microphone permissions.
- Uses `chat.send` against session key `main`.
- Talk TTS uses the normalized `talk.provider` + `talk.providers` config shape.
- Current streaming playback is documented for ElevenLabs on macOS/iOS/Android.
- `stability` for `eleven_v3` is validated to `0.0`, `0.5`, or `1.0`; other models accept `0..1`.
- `latency_tier` is validated to `0..4` when set.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency AudioTrack streaming.
