---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing audio transcription or media handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Audio and Voice Notes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Audio / Voice Notes — 2026-01-17（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Media understanding (audio)**: If audio understanding is enabled (or auto‑detected), OpenClaw:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. Locates the first audio attachment (local path or URL) and downloads it if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. Enforces `maxBytes` before sending to each model entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. Runs the first eligible model entry in order (provider or CLI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  4. If it fails or skips (size/timeout), it tries the next entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  5. On success, it replaces `Body` with an `[Audio]` block and sets `{{Transcript}}`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Command parsing**: When transcription succeeds, `CommandBody`/`RawBody` are set to the transcript so slash commands still work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Verbose logging**: In `--verbose`, we log when transcription runs and when it replaces the body.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-detection (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you **don’t configure models** and `tools.media.audio.enabled` is **not** set to `false`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw auto-detects in this order and stops at the first working option:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Local CLIs** (if installed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `sherpa-onnx-offline` (requires `SHERPA_ONNX_MODEL_DIR` with encoder/decoder/joiner/tokens)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `whisper-cli` (from `whisper-cpp`; uses `WHISPER_CPP_MODEL` or the bundled tiny model)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `whisper` (Python CLI; downloads models automatically)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Gemini CLI** (`gemini`) using `read_many_files`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Provider keys** (OpenAI → Groq → Deepgram → Google)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To disable auto-detection, set `tools.media.audio.enabled: false`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To customize, set `tools.media.audio.models`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: Binary detection is best-effort across macOS/Linux/Windows; ensure the CLI is on `PATH` (we expand `~`), or set an explicit CLI model with a full command path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Provider + CLI fallback (OpenAI + Whisper CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxBytes: 20971520,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          { provider: "openai", model: "gpt-4o-mini-transcribe" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            type: "cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            command: "whisper",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            args: ["--model", "base", "{{MediaPath}}"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            timeoutSeconds: 45,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Provider-only with scope gating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        scope: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          default: "allow",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          rules: [{ action: "deny", match: { chatType: "group" } }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Provider-only (Deepgram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tools: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      audio: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        models: [{ provider: "deepgram", model: "nova-3" }],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes & limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider auth follows the standard model auth order (auth profiles, env vars, `models.providers.*.apiKey`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deepgram picks up `DEEPGRAM_API_KEY` when `provider: "deepgram"` is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deepgram setup details: [Deepgram (audio transcription)](/providers/deepgram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audio providers can override `baseUrl`, `headers`, and `providerOptions` via `tools.media.audio`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default size cap is 20MB (`tools.media.audio.maxBytes`). Oversize audio is skipped for that model and the next entry is tried.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Default `maxChars` for audio is **unset** (full transcript). Set `tools.media.audio.maxChars` or per-entry `maxChars` to trim output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI auto default is `gpt-4o-mini-transcribe`; set `model: "gpt-4o-transcribe"` for higher accuracy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `tools.media.audio.attachments` to process multiple voice notes (`mode: "all"` + `maxAttachments`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transcript is available to templates as `{{Transcript}}`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI stdout is capped (5MB); keep CLI output concise.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gotchas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scope rules use first-match wins. `chatType` is normalized to `direct`, `group`, or `room`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure your CLI exits 0 and prints plain text; JSON needs to be massaged via `jq -r .text`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep timeouts reasonable (`timeoutSeconds`, default 60s) to avoid blocking the reply queue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
