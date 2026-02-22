# Mumble Voice Chat Extension

OpenClaw extension for voice conversations via Mumble VoIP.

## Features

- **Full voice conversation loop**: Talk to OpenClaw agents naturally via Mumble
- **High-quality audio**: 128kbps Opus encoding, 10ms frames (low latency)
- **Proactive speaking**: HTTP endpoint for scheduled voice messages
- **Voice selection**: Support for different TTS voices per request
- **Sender allowlist**: Restrict which Mumble users can trigger the bot
- **Silence detection**: Automatic speech processing with 500ms timeout

## Requirements

- **Mumble server** (tested with v1.5.857)
- **Whisper STT** (e.g., `http://localhost:8200/v1`)
- **Kokoro TTS** (e.g., `http://localhost:8102/v1`)
- **Node.js** v24+ (for @discordjs/opus native bindings)

## Installation

```bash
# Install dependencies
cd ~/.openclaw/extensions/mumble
npm install

# Build
npm run build

# Enable in config
openclaw config patch '{
  "plugins": {
    "entries": {
      "mumble": {
        "enabled": true
      }
    }
  }
}'
```

## Configuration

Full configuration example:

```json5
{
  plugins: {
    entries: {
      mumble: {
        enabled: true,
        config: {
          mumble: {
            host: "192.168.1.128",
            port: 64738,
            username: "OpenClaw-Bot",
            password: "optional-password",
            channel: "", // Root channel (or specific channel name)
          },
          audio: {
            whisperUrl: "http://localhost:8200/v1",
            kokoroUrl: "http://localhost:8102/v1",
            kokoroVoice: "af_nova+jf_alpha",
          },
          processing: {
            minSpeechDurationMs: 500,
            silenceTimeoutMs: 500,
            allowFrom: ["username1", "username2"], // Optional: restrict to specific users
          },
          gateway: {
            url: "http://localhost:18789",
            token: "your-gateway-token-here",
          },
        },
      },
    },
  },
}
```

### Configuration Fields

**`mumble`**: Mumble server connection

- `host`: Mumble server hostname/IP
- `port`: Mumble server port (default: 64738)
- `username`: Bot username on Mumble
- `password`: Optional server password
- `channel`: Channel to join (empty = root channel)

**`audio`**: Voice services

- `whisperUrl`: Whisper STT endpoint (OpenAI-compatible API)
- `kokoroUrl`: Kokoro TTS endpoint (OpenAI-compatible API)
- `kokoroVoice`: Default voice ID (e.g., `af_nicole`, `af_bella`, or blends like `af_nova+jf_alpha`)

**`processing`**: Audio processing

- `minSpeechDurationMs`: Minimum speech duration to process (default: 500ms)
- `silenceTimeoutMs`: Silence timeout after last packet (default: 500ms)
- `allowFrom`: Array of Mumble usernames allowed to trigger the bot (empty = allow all)

**`gateway`**: OpenClaw gateway

- `url`: Gateway base URL (default: http://localhost:18789)
- `token`: Gateway authentication token (from `gateway.auth.token` in config)

## Usage

### Interactive Voice Chat

1. Join the Mumble server with your client
2. Talk to the bot (push-to-talk or voice activation)
3. Bot transcribes your speech → sends to agent → speaks response

### Proactive Speaking (HTTP Endpoint)

Send voice messages programmatically:

```bash
# Use default voice
curl -X POST http://localhost:18789/mumble/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from OpenClaw"}'

# Use custom voice
curl -X POST http://localhost:18789/mumble/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello", "voice": "af_nicole"}'
```

### Cron Job Example

Schedule a weather announcement:

```bash
openclaw cron add --schedule "0 8 * * *" --isolated \
  --task 'Get weather and POST to http://localhost:18789/mumble/speak with voice message'
```

### Sender Allowlist

Restrict bot to specific users (useful when multiple bots share a channel):

```json
{
  "processing": {
    "allowFrom": ["Lophie", "Admin"]
  }
}
```

Users not in the allowlist will be silently ignored.

## Architecture

```
User speaks (Mumble PTT)
  ↓
Opus audio packets → Extension receives
  ↓
Decode Opus to PCM (opus-decoder WASM)
  ↓
Silence detection (500ms timeout)
  ↓
Convert to WAV → Whisper STT
  ↓
Text → OpenClaw Agent (/v1/chat/completions)
  ↓
Agent response → Kokoro TTS
  ↓
24kHz WAV → Resample to 48kHz
  ↓
Chunk into 10ms frames (480 samples)
  ↓
Encode to Opus (@discordjs/opus, 128kbps "audio" mode)
  ↓
Send to Mumble with 10ms timing
```

## Voice Options

### Available Kokoro Voices

**American Female:**

- `af_bella` - Warm, smooth
- `af_nicole` - Sultry
- `af_sarah` - Clear
- `af_sky` - Bright

**British Female:**

- `bf_emma` - Elegant, sophisticated

**American Male:**

- `am_adam` - Professional

**Voice Blending:**
Combine voices with `+`:

- `af_nova+jf_alpha` (American-Japanese blend)
- `bf_emma+pf_dora` (British-Portuguese blend)

See [Kokoro-82M](https://github.com/remsky/Kokoro-FastAPI) for all 67 voices.

## Troubleshooting

### No audio received from bot

1. Check Mumble server logs
2. Verify Kokoro TTS is running: `curl http://localhost:8102/health`
3. Check extension logs: `journalctl --user -u openclaw-gateway | grep mumble`

### Transcription not working

1. Verify Whisper is running: `curl http://localhost:8200/health`
2. Check logs for Whisper API errors
3. Ensure audio duration meets `minSpeechDurationMs`

### Bot responds to wrong users

1. Configure `allowFrom` to restrict by username
2. Check actual Mumble username: logs show `[voice-chat] <username> (ID X) said: "..."`
3. Username is case-sensitive

### HTTP endpoint not working

1. Verify gateway token in config matches `gateway.auth.token`
2. Check endpoint availability: `curl http://localhost:18789/mumble/speak`
3. Review gateway logs for errors

## Development

```bash
# Watch mode (rebuild on changes)
npm run build -- --watch

# Restart gateway after code changes
systemctl --user restart openclaw-gateway

# View logs
journalctl --user -u openclaw-gateway -f | grep mumble
```

## Technical Details

- **Audio codec**: Opus (type 4)
- **Frame size**: 480 samples (10ms at 48kHz)
- **Bitrate**: 128kbps
- **Application mode**: "audio" (optimized for TTS/music, not "voip")
- **Silence detection**: Timeout-based (500ms), not terminator packets
- **Resampling**: Linear interpolation (24kHz → 48kHz)

## Credits

- Mumble client: [`@tf2pickup-org/mumble-client`](https://github.com/tf2pickup-org/mumble-client) (fork with full audio support)
- Opus codec: [`@discordjs/opus`](https://github.com/discordjs/opus)
- Whisper STT: [OpenAI Whisper](https://github.com/openai/whisper)
- Kokoro TTS: [Kokoro-82M](https://github.com/remsky/Kokoro-FastAPI)

## License

Same as OpenClaw (check main repo LICENSE)
