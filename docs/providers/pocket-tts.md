---
summary: "Local CPU-based TTS with Pocket TTS"
read_when:
  - You want local text-to-speech without cloud APIs
  - You need free, offline TTS
  - You want voice cloning capabilities
---

# Pocket TTS

[Pocket TTS](https://github.com/kyutai-labs/pocket-tts) is a local, CPU-only text-to-speech engine from Kyutai Labs. It runs entirely on your machine with no API keys required.

**Highlights:**

- ~100M parameter model, runs on CPU
- ~200ms latency to first audio chunk
- 6× realtime on MacBook Air M4
- Voice cloning via reference audio file
- 8 built-in voices
- Fully offline after initial model download (~400MB)

## Quick start

1. Install Pocket TTS:

```bash
# Using pip
pip install pocket-tts

# Or using uv (faster)
uv pip install pocket-tts
```

2. Start the server:

```bash
pocket-tts serve --voice alba
```

3. Configure OpenClaw:

```json5
{
  messages: {
    tts: {
      provider: "pocket",
      pocket: {
        baseUrl: "http://localhost:8000", // default
        voice: "alba", // default
      },
    },
  },
}
```

4. Enable TTS:

```
/tts always
```

## Built-in voices

Pocket TTS includes 8 built-in voices (Les Misérables characters):

| Voice     | Description   |
| --------- | ------------- |
| `alba`    | Default voice |
| `marius`  | Male voice    |
| `javert`  | Male voice    |
| `jean`    | Male voice    |
| `fantine` | Female voice  |
| `cosette` | Female voice  |
| `eponine` | Female voice  |
| `azelma`  | Female voice  |

## Custom voices

Pocket TTS supports three voice sources:

### 1. Built-in voices

The 8 built-in voices listed above (`alba`, `marius`, etc.).

### 2. HuggingFace voice repository

Use `hf://` URLs to load voices from HuggingFace:

```json5
{
  messages: {
    tts: {
      pocket: {
        voice: "hf://kyutai/tts-voices/mimi_16khz.wav",
      },
    },
  },
}
```

Browse available voices: [kyutai/tts-voices on HuggingFace](https://huggingface.co/kyutai/tts-voices/tree/main)

### 3. HTTP/HTTPS URLs

Point to any WAV file hosted online:

```json5
{
  messages: {
    tts: {
      pocket: {
        voice: "https://example.com/my-voice.wav",
      },
    },
  },
}
```

### 4. Local files (server-side only)

Local file paths work only when starting the server manually:

```bash
# Start server with local voice file
pocket-tts serve --voice /path/to/your-voice.wav
```

**Note:** Local paths cannot be passed via the API - use `hf://` or `http://` URLs in config instead.

## Configuration

### Full config options

```json5
{
  messages: {
    tts: {
      provider: "pocket", // Use pocket as primary provider
      pocket: {
        enabled: true, // Enable/disable pocket (default: true)
        baseUrl: "http://localhost:8000", // Server URL (also used for auto-start binding)
        voice: "alba", // Voice name or URL
        autoStart: false, // Auto-start server if not running (default: false)
      },
    },
  },
}
```

### Auto-start mode

OpenClaw can automatically start `pocket-tts serve` when it's not running:

```json5
{
  messages: {
    tts: {
      provider: "pocket",
      pocket: {
        baseUrl: "http://localhost:8000", // Host/port derived from this URL
        autoStart: true, // Spawn server automatically
        voice: "alba", // Voice to use when starting
      },
    },
  },
}
```

**How it works:**

1. OpenClaw checks `/health` endpoint
2. If server is down and `autoStart: true`, spawns `pocket-tts serve`
3. Host and port are derived from `baseUrl` (e.g., `http://localhost:9000` → `--host localhost --port 9000`)
4. Waits up to 30s for server to become healthy (model loading)
5. Server is stopped automatically when OpenClaw exits

**Note:** First request may be slow (~10-30s) while the model loads. Subsequent requests are fast (~200ms).

### Environment variables

Pocket TTS doesn't require API keys:

```bash
# Manual start (recommended for production)
pocket-tts serve --voice alba

# Or let OpenClaw auto-start via config
```

## Provider fallback

OpenClaw tries providers in order: **OpenAI → ElevenLabs → Edge → Pocket**

When Pocket TTS is configured but the server isn't running:

1. If `autoStart: true`, OpenClaw tries to start the server
2. If that fails (or `autoStart: false`), falls back to next provider

To check if the server is running:

```bash
curl http://localhost:8000/health
# Returns: {"status": "healthy"}
```

### Using Pocket as primary

To use Pocket first (before cloud providers):

```json5
{
  messages: {
    tts: {
      provider: "pocket", // Try pocket first, fall back to others
    },
  },
}
```

## Comparison with other providers

| Provider   | API Key | Latency | Cost            | Offline | Output  |
| ---------- | ------- | ------- | --------------- | ------- | ------- |
| Pocket TTS | No      | ~200ms  | Free            | Yes     | WAV     |
| Edge TTS   | No      | ~500ms  | Free            | No      | MP3     |
| OpenAI     | Yes     | ~300ms  | $0.015/1K chars | No      | MP3/WAV |
| ElevenLabs | Yes     | ~400ms  | $0.30/1K chars  | No      | MP3     |

**Note:** Pocket TTS outputs WAV format (uncompressed). File sizes are ~5-10x larger than MP3 (~100KB vs ~15KB for short phrases). Most messaging platforms handle this fine.

**First run:** Downloads ~400MB model from HuggingFace on first use. After that, it's fully offline.

## Troubleshooting

### Server not running

If you see "pocket: server not running", start the server:

```bash
pocket-tts serve --voice alba
```

Or enable auto-start in config:

```json5
{ messages: { tts: { pocket: { autoStart: true } } } }
```

### pocket-tts not installed

If auto-start fails with "ENOENT" or "command not found":

```bash
# Install pocket-tts
pip install pocket-tts

# Verify installation
pocket-tts --help
```

### Wrong Python version

Pocket TTS requires Python 3.10+:

```bash
python3 --version
# Should be 3.10 or higher
```

### Model loading slow

First request takes 10-30s to load the model. This is normal.
Subsequent requests are fast (~200ms).

### Invalid voice error

If you see a voice validation warning, check your voice format:

| Format          | Example                                 | Supported                                    |
| --------------- | --------------------------------------- | -------------------------------------------- |
| Built-in name   | `alba`                                  | ✅                                           |
| HuggingFace URL | `hf://kyutai/tts-voices/mimi_16khz.wav` | ✅                                           |
| HTTP/HTTPS URL  | `https://example.com/voice.wav`         | ✅                                           |
| Local file path | `/path/to/voice.wav`                    | ❌ (use `--voice` flag when starting server) |

**Note:** OpenClaw warns about unrecognized voices but still sends them to the server. The server gives the authoritative error if the voice is truly invalid.

### Missing dependencies

```bash
# Reinstall with all dependencies
pip install pocket-tts[audio]
```

## Links

- [Pocket TTS GitHub](https://github.com/kyutai-labs/pocket-tts)
- [Kyutai Labs](https://kyutai.org)
- [HuggingFace Model](https://huggingface.co/kyutai/pocket-tts-v1)
