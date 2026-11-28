# Fish Audio speech plugin

Official OpenClaw speech provider for Fish Audio's hosted S3 Pro, Drama 3, and S2.1 APIs.

Install it with:

```bash
openclaw plugins install @openclaw/fish-audio-speech
```

The plugin id is `fish-audio-speech`; the speech provider and TTS config id
remain `fish-audio`. Configure `tts.provider: "fish-audio"` and set
`FISH_API_KEY`. The provider supports buffered audio, HTTP-streamed playback,
native Opus voice notes, 8 kHz PCM telephony, and Fish Audio voice discovery.

The default model is `s3-pro`. Set `tts.providers.fish-audio.model: "drama-3"`
for Drama 3 voice direction, or `"s2.1-pro"` for S2.1. Natural-language
directions such as `[calm, reassuring]` and paired tags such as
`<whisper>...</whisper>` are passed through in the spoken text.

See [Fish Audio](https://docs.openclaw.ai/providers/fish-audio) for setup,
models, voice selection, expressive tags, and local macOS MLX usage.
