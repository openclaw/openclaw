# Faster Whisper Server

A persistent local transcription server that provides sub-second voice note transcription by keeping the `faster-whisper` model preloaded in memory.

## Why

OpenAI Whisper CLI (`whisper`) cold-starts in 3-5s per call due to model loading overhead. A persistent server eliminates this by loading the model once at startup.

| Approach                  | Latency     |
| ------------------------- | ----------- |
| OpenAI Whisper CLI (cold) | ~5s         |
| OpenAI Whisper CLI (warm) | ~3s         |
| **faster-whisper server** | **~0.7-1s** |

## Architecture

```
OpenClaw voice note
  → whisper CLI wrapper
    → faster-whisper server (port 15555)
      → faster-whisper model (preloaded in memory)
```

The wrapper binary is fully backward compatible. If the server is unavailable, calls fall back to the original OpenAI Whisper CLI automatically.

## Setup

### 1. Install faster-whisper

```bash
pip install faster-whisper
```

### 2. Install the server script

Save `scripts/faster-whisper-server.py` to your OpenClaw tools directory (e.g. `~/.openclaw/tools/`).

### 3. Create the launchd service (macOS)

Save `scripts/com.openclaw.faster-whisper-server.plist` to `~/Library/LaunchAgents/` and load it:

```bash
cp scripts/com.openclaw.faster-whisper-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.faster-whisper-server.plist
```

The server starts automatically on boot and preloads the `base` model on startup.

### 4. Replace the whisper binary wrapper

Replace `/opt/homebrew/bin/whisper` with the wrapper script at `scripts/whisper-wrapper.py`. The wrapper routes all calls to the faster-whisper server on port 15555 and falls back to the original OpenAI Whisper CLI if the server is unavailable.

```bash
# Backup original
sudo mv /opt/homebrew/bin/whisper /opt/homebrew/bin/whisper.original

# Install wrapper
sudo cp scripts/whisper-wrapper.py /opt/homebrew/bin/whisper
sudo chmod +x /opt/homebrew/bin/whisper
```

### 5. Verify

```bash
whisper /path/to/audio.ogg --output_format txt
# Should return transcription in ~1s
```

## Server Protocol

The server listens on `127.0.0.1:15555` and accepts JSON requests:

```json
{ "audio": "/path/to/file.ogg", "language": "en" }
```

Response:

```json
{ "text": "transcribed text", "language": "en" }
```

## Troubleshooting

**Latency still high?** The server logs to `/tmp/faster-whisper-server.log`. Check if the model loaded correctly.

**Server won't start?** Ensure port 15555 is not in use: `lsof -i :15555`.

**Fallback not working?** Check that `whisper.original` exists at `/opt/homebrew/bin/whisper.original`.
