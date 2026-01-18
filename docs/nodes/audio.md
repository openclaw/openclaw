---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
---
# Audio / Voice Notes — 2026-01-17

## What works
- **Media understanding (audio)**: If `tools.media.audio` is enabled (or a shared `tools.media.models` entry supports audio), Clawdbot:
  1) Locates the first audio attachment (local path or URL) and downloads it if needed.
  2) Enforces `maxBytes` before sending to each model entry.
  3) Runs the first eligible model entry in order (provider or CLI).
  4) If it fails or skips (size/timeout), it tries the next entry.
  5) On success, it replaces `Body` with an `[Audio]` block and sets `{{Transcript}}`.
- **Command parsing**: When transcription succeeds, `CommandBody`/`RawBody` are set to the transcript so slash commands still work.
- **Verbose logging**: In `--verbose`, we log when transcription runs and when it replaces the body.

## Config examples

### Provider + CLI fallback (OpenAI + Whisper CLI)
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "whisper-1" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45
          }
        ]
      }
    }
  }
}
```

### Provider-only with scope gating
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [
            { action: "deny", match: { chatType: "group" } }
          ]
        },
        models: [
          { provider: "openai", model: "whisper-1" }
        ]
      }
    }
  }
}
```

### Provider-only (Deepgram)
```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }]
      }
    }
  }
}
```

## Notes & limits
- Provider auth follows the standard model auth order (auth profiles, env vars, `models.providers.*.apiKey`).
- Deepgram picks up `DEEPGRAM_API_KEY` when `provider: "deepgram"` is used.
- Deepgram setup details: [Deepgram (audio transcription)](/providers/deepgram).
- Audio providers can override `baseUrl`, `headers`, and `providerOptions` via `tools.media.audio`.
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Oversize audio is skipped for that model and the next entry is tried.
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.
- Use `tools.media.audio.attachments` to process multiple voice notes (`mode: "all"` + `maxAttachments`).
- Transcript is available to templates as `{{Transcript}}`.
- CLI stdout is capped (5MB); keep CLI output concise.

## Gotchas
- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.
- Ensure your CLI exits 0 and prints plain text; JSON needs to be massaged via `jq -r .text`.
- Keep timeouts reasonable (`timeoutSeconds`, default 60s) to avoid blocking the reply queue.
