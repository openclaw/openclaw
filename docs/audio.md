---
summary: "How inbound audio/voice notes are downloaded, transcribed, and injected into replies"
read_when:
  - Changing audio transcription or media handling
---
<!-- {% raw %} -->
# Audio / Voice Notes — 2025-12-05

## What works
- **Optional transcription**: If `routing.transcribeAudio.command` is set in `~/.clawdis/clawdis.json`, CLAWDIS will:
  1) Download inbound audio to a temp path when WhatsApp only provides a URL.
  2) Run the configured CLI (templated with `{{MediaPath}}`), expecting transcript on stdout.
  3) Replace `Body` with the transcript, set `{{Transcript}}`, and prepend the original media path plus a `Transcript:` section in the command prompt so models see both.
  4) Continue through the normal auto-reply pipeline (templating, sessions, Pi command).
- **Verbose logging**: In `--verbose`, we log when transcription runs and when the transcript replaces the body.

## Config example (OpenAI Whisper CLI)
Requires `OPENAI_API_KEY` in env and `openai` CLI installed:
```json5
{
  routing: {
    transcribeAudio: {
      command: [
        "openai",
        "api",
        "audio.transcriptions.create",
        "-m",
        "whisper-1",
        "-f",
        "{{MediaPath}}",
        "--response-format",
        "text"
      ],
      timeoutSeconds: 45
    }
  }
}
```

## Notes & limits
- We don’t ship a transcriber; you opt in with any CLI that prints text to stdout (Whisper cloud, whisper.cpp, vosk, Deepgram, etc.).
- Size guard: inbound audio must be ≤5 MB (matches the temp media store and transcript pipeline).
- Outbound caps: web send supports audio/voice up to 16 MB (sent as a voice note with `ptt: true`).
- If transcription fails, we fall back to the original body/media note; replies still go through.
- Transcript is available to templates as `{{Transcript}}`; models get both the media path and a `Transcript:` block in the prompt when using command mode.

## Gotchas
- Ensure your CLI exits 0 and prints plain text; JSON needs to be massaged via `jq -r .text`.
- Keep timeouts reasonable (`timeoutSeconds`, default 45s) to avoid blocking the reply queue.
<!-- {% endraw %} -->
