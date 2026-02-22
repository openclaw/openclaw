# @openclaw/feishu-media

Feishu audio speech-to-text (STT) and media payload utilities plugin.

## Enabling the Plugin

This plugin is **disabled by default**. To activate it, set `enabled: true` in the
`plugins.entries` section of your openclaw configuration:

```jsonc
// openclaw.json
{
  "plugins": {
    "entries": {
      "feishu-media": {
        "enabled": true,
        "config": {
          "sttProvider": "auto"
        }
      }
    }
  }
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Feishu native STT** | Uses Feishu's native `speech_to_text` API to convert voice messages to text. Automatically manages tenant access token caching and rate-limit retries. |
| **Whisper STT** | Transcribes audio via a remote HTTP service or local CLI using OpenAI Whisper, serving as a fallback for Feishu STT. |
| **Media payload** | `buildFeishuMediaPayload()` — Builds media payload for feishu channel messages with `Transcript` field support. |
| **Media debug** | `createMediaDebugLogger()` — Debug logging utility for the media understanding pipeline. |

## Configuration

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sttEnabled` | boolean | `true` | Enable audio speech-to-text recognition |
| `sttProvider` | string | `"auto"` | STT provider: `"feishu"` (native API), `"whisper"` (external service or local CLI), `"auto"` (try whisper first then feishu) |
| `whisperUrl` | string | — | Optional Whisper HTTP service URL. Falls back to `OPENCLAW_WHISPER_URL` env var |
| `whisperScript` | string | — | Path to local `whisper_stt.py` script. Falls back to `OPENCLAW_WHISPER_SCRIPT` env var |
| `sttTimeoutMs` | number | `30000` | Timeout for STT HTTP requests in milliseconds |

## Exported API

### feishu-stt

| Export | Description |
|--------|-------------|
| `resolveFeishuApiBase(domain?)` | Resolve Feishu/Lark Open-API base URL |
| `getFeishuTenantAccessToken(params)` | Get (or refresh) a tenant access token |
| `recognizeAudioWithFeishuStt(params)` | Feishu native speech recognition; silently returns `undefined` on failure |

### whisper-stt

| Export | Description |
|--------|-------------|
| `recognizeAudioWithWhisper(opts)` | Whisper STT (remote HTTP or local CLI); silently returns `undefined` on failure |

### media-payload

| Export | Description |
|--------|-------------|
| `FeishuMediaInfoExt` | Media info type with optional `transcript` field |
| `FeishuMediaPayload` | Media payload type (includes `Transcript`) |
| `buildFeishuMediaPayload(mediaList)` | Build feishu media payload |

### media-debug

| Export | Description |
|--------|-------------|
| `MediaDebugLogger` | Debug logger type |
| `createMediaDebugLogger(prefix?)` | Create a media understanding debug logger |

## Development

```bash
cd extensions/feishu-media
npm install
npm test
```
