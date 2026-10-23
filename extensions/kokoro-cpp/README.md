# kokoro.cpp Text-to-Speech

Use a local [kokoro.cpp](https://github.com/larroy/kokoro.cpp) server to
generate OpenClaw's spoken replies. The plugin talks to the server's
OpenAI-compatible `/v1/audio/speech` endpoint; it does not build kokoro.cpp or
download voice models.

## Get started

Build kokoro.cpp and start its server from the checkout root:

```bash
uv run bootstrap.py configure
uv run bootstrap.py build
./build/kokoro-server
```

The server listens on `127.0.0.1:8880` by default. Set `tts.provider` to
`kokoro-cpp` and add a `tts.providers.kokoro-cpp` block; an empty block `{}`
uses the defaults:

```json5
{
  tts: {
    provider: "kokoro-cpp",
    providers: {
      "kokoro-cpp": {
        baseUrl: "http://127.0.0.1:8880/v1",
        voice: "af_maple",
        speed: 1.0,
      },
    },
  },
}
```

`openclaw infer tts voices --provider kokoro-cpp` lists the voices the server
loaded. Install FFmpeg when voice notes need WAV converted to Opus. Telephony
uses the server's raw 24 kHz PCM output.

The server has no authentication; keep it bound to loopback.
