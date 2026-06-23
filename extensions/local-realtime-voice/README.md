# OpenClaw Local Realtime Voice

A free, self-hosted realtime voice provider for OpenClaw.

- **Realtime voice assistant** — talk to your agent; it replies with synthesized speech.
- **Realtime dictation** — speak and your words appear as text.
- **No paid APIs** — runs entirely on your own hardware using Whisper, Kokoro, and Ollama.

## Requirements

- OpenClaw gateway ≥ `2026.3.24-beta.2`
- Docker (or native installs of Whisper, Kokoro, and Ollama)
- ffmpeg
- A running Ollama server with at least one chat model

## Quick start

### 1. Start the backend services

```bash
# Whisper STT (CPU; runs on http://127.0.0.1:8000)
docker run -d --name whisper \
  -p 127.0.0.1:8000:8000 \
  -e WHISPER__MODEL=Systran/faster-whisper-tiny.en \
  -e WHISPER__PRELOAD_MODELS='["Systran/faster-whisper-tiny.en"]' \
  -e WHISPER__MODEL__LOAD_ON_STARTUP=true \
  --restart unless-stopped \
  fedirz/faster-whisper-server:latest-cpu

# Kokoro TTS (CPU; runs on http://127.0.0.1:8880)
docker run -d --name kokoro \
  -p 127.0.0.1:8880:8880 \
  --restart unless-stopped \
  ghcr.io/remsky/kokoro-fastapi-cpu:v0.1.4

# Ollama must already be running on http://127.0.0.1:11434
```

### 2. Install the plugin

**Stock extension (if merged):**

```bash
openclaw plugins install @openclaw/local-realtime-voice
```

**From npm (Option B):**

```bash
openclaw plugins install openclaw-local-realtime-voice
```

**From a local path:**

```bash
openclaw plugins install --link /path/to/openclaw-local-realtime-voice
```

### 3. Configure OpenClaw

```bash
openclaw config set talk.realtime.provider local
openclaw config set plugins.entries.voice-call.config.streaming.provider local
```

### 4. Use it

- **Realtime Talk**: hold/press the talk button in the OpenClaw Companion app and speak.
- **Dictation**: tap the mic button in the text input and speak.

## Configuration

All values are optional and default to local endpoints.

| Key | Default | Description |
|---|---|---|
| `whisperBaseUrl` | `http://127.0.0.1:8000` | faster-whisper-server endpoint |
| `whisperModel` | `""` | Specific Whisper model; empty uses the server default |
| `kokoroBaseUrl` | `http://127.0.0.1:8880` | Kokoro TTS endpoint |
| `kokoroVoice` | `af` | Kokoro voice |
| `ollamaBaseUrl` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `chatModel` | primary Ollama model | Model used for assistant replies |
| `vadThreshold` | `100` | Voice activity detection energy threshold |
| `silenceMs` | `1200` | Silence before a voice turn ends |
| `maxTurnMs` | `15000` | Maximum voice turn length |
| `partialIntervalMs` | `2000` | Rolling dictation partial interval |
| `audioChunkMs` | `50` | Assistant audio chunk size |

## Performance notes

- Use the `tiny.en` Whisper model for the lowest latency on CPU.
- For better accuracy at the cost of latency, use `base` or `small`.
- GPU containers (`latest` instead of `latest-cpu`, `kokoro-fastapi-cuda` etc.) significantly reduce latency if you have a compatible GPU.

## License

MIT
