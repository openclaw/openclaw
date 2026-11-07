# HeyGen Voice speech plugin

Official OpenClaw speech provider for HeyGen Voice.

Install it with:

```bash
openclaw plugins install @openclaw/heygen-speech
```

The plugin id is `heygen-speech`; the speech provider and TTS config id are
`heygen`. Configure `tts.provider: "heygen"` and set `HEYGEN_API_KEY`. The
provider supports buffered audio, streamed playback over HTTP, Opus
voice notes through `ffmpeg`, 24 kHz PCM telephony, and voice discovery.

See [HeyGen Voice](https://docs.openclaw.ai/providers/heygen) for setup, models,
voice selection, and instant voice clones.

## Instant voice clones

The provider uses existing voice ids and does not create voices. To clone a
voice from a recording you have the right to use, call the HeyGen API:

```bash
curl https://api.heygen.com/v3/models/audio/voices \
  -H "x-api-key: $HEYGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"mode\": \"instant\",
    \"name\": \"My voice\",
    \"language\": \"en\",
    \"audio\": [{
      \"type\": \"base64\",
      \"media_type\": \"audio/mpeg\",
      \"data\": \"$(base64 < recording.mp3 | tr -d '\n')\"
    }]
  }"
```

Take `data.voice_id` from the response and set it as
`tts.providers.heygen.speakerVoiceId`.
