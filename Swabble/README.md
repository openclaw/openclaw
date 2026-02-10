# 🎙️ swabble — Speech.framework wake-word hook daemon (macOS 26)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swabble is a Swift 6.2 wake-word hook daemon. The CLI targets macOS 26 (SpeechAnalyzer + SpeechTranscriber). The shared `SwabbleKit` target is multi-platform and exposes wake-word gating utilities for iOS/macOS apps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local-only**: Speech.framework on-device models; zero network usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Wake word**: Default `clawd` (aliases `claude`), optional `--no-wake` bypass.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SwabbleKit**: Shared wake gate utilities (gap-based gating when you provide speech segments).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hooks**: Run any command with prefix/env, cooldown, min_chars, timeout.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Services**: launchd helper stubs for start/stop/install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File transcribe**: TXT or SRT with time ranges (using AttributedString splits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install deps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
brew install swiftformat swiftlint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Write default config (~/.config/swabble/config.json)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run swabble setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Run foreground daemon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run swabble serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Test your hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run swabble test-hook "hello world"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Transcribe a file to SRT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run swabble transcribe /path/to/audio.m4a --format srt --output out.srt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Use as a library（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add swabble as a SwiftPM dependency and import the `Swabble` or `SwabbleKit` product:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```swift（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Package.swift（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
dependencies: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    .package(url: "https://github.com/steipete/swabble.git", branch: "main"),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
targets: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    .target(name: "MyApp", dependencies: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        .product(name: "Swabble", package: "swabble"),     // Speech pipeline (macOS 26+ / iOS 26+)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        .product(name: "SwabbleKit", package: "swabble"),  // Wake-word gate utilities (iOS 17+ / macOS 15+)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ]),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `serve` — foreground loop (mic → wake → hook)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `transcribe <file>` — offline transcription (txt|srt)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `test-hook "text"` — invoke configured hook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mic list|set <index>` — enumerate/select input device（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setup` — write default config JSON（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `doctor` — check Speech auth & device availability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `health` — prints `ok`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tail-log` — last 10 transcripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `status` — show wake state + recent transcripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `service install|uninstall|status` — user launchd plist (stub: prints launchctl commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `start|stop|restart` — placeholders until full launchd wiring（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All commands accept Commander runtime flags (`-v/--verbose`, `--json-output`, `--log-level`), plus `--config` where applicable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.config/swabble/config.json` (auto-created by `setup`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "audio": {"deviceName": "", "deviceIndex": -1, "sampleRate": 16000, "channels": 1},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "wake": {"enabled": true, "word": "clawd", "aliases": ["claude"]},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "hook": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "command": "",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "args": [],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "prefix": "Voice swabble from ${hostname}: ",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "cooldownSeconds": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "minCharacters": 24,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "timeoutSeconds": 5,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "env": {}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "logging": {"level": "info", "format": "text"},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "transcripts": {"enabled": true, "maxEntries": 50},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "speech": {"localeIdentifier": "en_US", "etiquetteReplacements": false}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config path override: `--config /path/to/config.json` on relevant commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transcripts persist to `~/Library/Application Support/swabble/transcripts.log`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Hook protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a wake-gated transcript passes min_chars & cooldown, swabble runs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<command> <args...> "<prefix><text>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Environment variables:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SWABBLE_TEXT` — stripped transcript (wake word removed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SWABBLE_PREFIX` — rendered prefix (hostname substituted)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- plus any `hook.env` key/values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Speech pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `AVAudioEngine` tap → `BufferConverter` → `AnalyzerInput` → `SpeechAnalyzer` with a `SpeechTranscriber` module.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requests volatile + final results; the CLI uses text-only wake gating today.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Authorization requested at first start; requires macOS 26 + new Speech.framework APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Development（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Format: `./scripts/format.sh` (uses local `.swiftformat`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint: `./scripts/lint.sh` (uses local `.swiftlint.yml`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: `swift test` (uses swift-testing package)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Roadmap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- launchd control (load/bootout, PID + status socket)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- JSON logging + PII redaction toggle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stronger wake-word detection and control socket status/health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
