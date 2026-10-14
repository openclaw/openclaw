# Fish Audio speech plugin

Official OpenClaw speech provider for Fish Audio's hosted S2.1 and Drama 3 APIs.

Install it with:

```bash
openclaw plugins install @openclaw/fish-audio-speech
```

The plugin id is `fish-audio-speech`; the speech provider and TTS config id
remain `fish-audio`. Configure `tts.provider: "fish-audio"` and set
`FISH_API_KEY`. The provider supports buffered audio, HTTP-streamed playback,
native Opus voice notes, 8 kHz PCM telephony, and Fish Audio voice discovery.

Set `tts.providers.fish-audio.model: "drama-3-preview"` to opt in to Drama 3
voice direction. The default remains `s2.1-pro`. Natural-language directions
such as `[calm, reassuring]` and paired tags such as `<whisper>...</whisper>`
are passed through in the spoken text.

See [Fish Audio](https://docs.openclaw.ai/providers/fish-audio) for setup,
models, voice selection, expressive tags, and local macOS MLX usage.
