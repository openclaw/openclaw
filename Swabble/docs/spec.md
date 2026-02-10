# swabble — macOS 26 speech hook daemon (Swift 6.2)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: brabble-style always-on voice hook for macOS 26 using Apple Speech.framework (SpeechAnalyzer + SpeechTranscriber) instead of whisper.cpp. Local-only, wake word gated, dispatches a shell hook with the transcript. Shared wake-gate utilities live in `SwabbleKit` for reuse by other apps (iOS/macOS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Requirements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS 26+, Swift 6.2, Speech.framework with on-device assets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local only; no network calls during transcription.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wake word gating (default "clawd" plus aliases) with bypass flag `--no-wake`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SwabbleKit` target (multi-platform) providing wake-word gating helpers that can use speech segment timing to require a post-trigger gap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hook execution with cooldown, min_chars, timeout, prefix, env vars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Simple config at `~/.config/swabble/config.json` (JSON, Codable) — no TOML.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI implemented with Commander (SwiftPM package `steipete/Commander`); core types are available via the SwiftPM library product `Swabble` for embedding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Foreground `serve`; later launchd helper for start/stop/restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- File transcription command emitting txt or srt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Basic status/health surfaces and mic selection stubs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI layer (Commander)**: Root command `swabble` with subcommands `serve`, `transcribe`, `test-hook`, `mic list|set`, `doctor`, `health`, `tail-log`. Runtime flags from Commander (`-v/--verbose`, `--json-output`, `--log-level`). Custom `--config` path applies everywhere.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Config**: `SwabbleConfig` Codable. Fields: audio device name/index, wake (enabled/word/aliases/sensitivity placeholder), hook (command/args/prefix/cooldown/min_chars/timeout/env), logging (level, format), transcripts (enabled, max kept), speech (locale, enableEtiquetteReplacements flag). Stored JSON; default written by `setup`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Audio + Speech pipeline**: `SpeechPipeline` wraps `AVAudioEngine` input → `SpeechAnalyzer` with `SpeechTranscriber` module. Emits partial/final transcripts via async stream. Requests `.audioTimeRange` when transcripts enabled. Handles Speech permission and asset download prompts ahead of capture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Wake gate**: CLI currently uses text-only keyword match; shared `SwabbleKit` gate can enforce a minimum pause between the wake word and the next token when speech segments are available. `--no-wake` disables gating.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hook executor**: async `HookExecutor` spawns `Process` with configured args, prefix substitution `${hostname}`. Enforces cooldown + timeout; injects env `SWABBLE_TEXT`, `SWABBLE_PREFIX` plus user env map.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Transcripts store**: in-memory ring buffer; optional persisted JSON lines under `~/Library/Application Support/swabble/transcripts.log`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Logging**: simple structured logger to stderr; respects log level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Out of scope (initial cut)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model management (Speech handles assets).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Launchd helper (planned follow-up).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Advanced wake-word detector (segment-aware gate now lives in `SwabbleKit`; CLI still text-only until segment timing is plumbed through).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Whether to expose a UNIX control socket for `status`/`health` (currently planned as stdin/out direct calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hook redaction (PII) parity with brabble — placeholder boolean, no implementation yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
