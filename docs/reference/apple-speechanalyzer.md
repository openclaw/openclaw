---
summary: "Apple's on-device SpeechAnalyzer / SpeechTranscriber API (macOS 26 / iOS 26): requirements, permissions, model assets, a minimal runnable Swift demo, common errors, and how it maps to the in-tree Swabble implementation."
read_when:
  - Adding local speech-to-text to a macOS or iOS surface
  - Evaluating Apple SpeechAnalyzer vs Whisper for on-device transcription
  - Debugging model-asset download or audio-format errors with SpeechTranscriber
title: "Apple SpeechAnalyzer API"
---

Apple's **SpeechAnalyzer** (with the **SpeechTranscriber** module) is the on-device
speech-to-text API introduced in the **macOS 26 / iOS 26** SDK generation. It replaces
`SFSpeechRecognizer` for new work: fully local, no network, streaming or file-based,
with per-locale models that download on demand. Apple presented it as competitive with
Whisper while running entirely on-device
([HN discussion](https://news.ycombinator.com/), WWDC25 session
["Bring advanced speech-to-text to your app with SpeechAnalyzer"](https://developer.apple.com/videos/play/wwdc2025/277/)).

- API reference: [`SpeechAnalyzer`](https://developer.apple.com/documentation/speech/speechanalyzer) ·
  [`SpeechTranscriber`](https://developer.apple.com/documentation/speech/speechtranscriber) ·
  [Speech framework](https://developer.apple.com/documentation/speech)
- In-tree reference implementation: **`Swabble`** (`Swabble/Sources/SwabbleCore/Speech/`) —
  live mic pipeline (`SpeechPipeline.swift`) and file transcription
  (`Sources/swabble/Commands/TranscribeCommand.swift`).

> **Verified locally (2026-07-14, macOS 26.3, Xcode 26.2, Swift 6.2.3, Apple Silicon).**
> The minimal demo below transcribed a 27 s Chinese voice memo end-to-end after an
> automatic `zh-CN` model download. See [Verification](#verification-steps).

## Requirements

| Requirement | Value |
| --- | --- |
| OS | macOS 26.0+ / iOS 26.0+ (also iPadOS 26, visionOS 26) |
| Toolchain | Xcode 26+, Swift 6.2+ |
| Frameworks | `Speech`, `AVFoundation` |
| Hardware | Apple Silicon recommended; models run on-device |
| Network | Only for the first per-locale model download; transcription itself is offline |

All symbols are gated behind availability. Annotate the enclosing type/function or use a
runtime check, or the compiler errors with *"'SpeechAttributes' is only available in
macOS 26.0 or newer"*:

```swift
@available(macOS 26.0, iOS 26.0, *)
func transcribe() async throws { /* ... */ }
```

In a SwiftPM package, set the platform floor so the whole target is 26+:

```swift
platforms: [.macOS(.v26), .iOS(.v26)]
```

## Permissions

Add to **Info.plist** (both keys, even for file-only transcription some flows touch the
recognizer):

- `NSSpeechRecognitionUsageDescription` — "Used to transcribe your speech on-device."
- `NSMicrophoneUsageDescription` — required only for **live mic** capture.

Request authorization once before starting a live pipeline:

```swift
import Speech

let status = await withCheckedContinuation { cont in
    SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
}
guard status == .authorized else { throw MyError.speechDenied }
```

File-based transcription of audio you already own does not strictly require microphone
permission, but still needs the model asset (below).

## Model assets

Each locale has an on-device model that is **downloaded on first use**, not bundled.
Check support, check whether it is installed, and install if needed:

```swift
func ensureModel(for transcriber: SpeechTranscriber, locale: Locale) async throws {
    let want = locale.identifier(.bcp47)
    let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    guard supported.contains(want) else { throw MyError.localeUnsupported }

    let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
    guard !installed.contains(want) else { return }

    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()   // progress via request.progress
    }
}
```

The download is a few hundred MB per locale on first run; subsequent runs are instant.

## Audio input flow

Two entry points on `SpeechAnalyzer`:

1. **File** — `analyzer.start(inputAudioFile:finishAfterFile:)`. Simplest; best for
   batch/offline. Requires an `AVAudioFile` that Core Audio can open (see the format
   gotcha below).
2. **Live stream** — feed `AnalyzerInput` buffers from an `AVAudioEngine` input tap into
   an `AsyncStream`, converting to `SpeechAnalyzer.bestAvailableAudioFormat(...)`.

In both cases you read results from `transcriber.results` — an async sequence of
`AttributedString` chunks. With `reportingOptions: [.volatileResults]` you also get
partial (in-progress) hypotheses before the finalized text; `result.isFinal` distinguishes
them. Add `attributeOptions: [.audioTimeRange]` to get per-run timing (needed for SRT).

## Minimal runnable demo

A complete, self-contained SwiftPM package (file transcription). This is exactly what was
run to verify this doc.

`Package.swift`:

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "speechdemo",
    platforms: [.macOS(.v26)],
    targets: [.executableTarget(name: "speechdemo", path: "Sources/speechdemo")]
)
```

`Sources/speechdemo/main.swift`:

```swift
import AVFoundation
import Foundation
import Speech

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

func ensureModel(for transcriber: SpeechTranscriber, locale: Locale) async throws {
    let want = locale.identifier(.bcp47)
    let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }
    guard supported.contains(want) else {
        log("Locale \(want) not supported. Have: \(supported.sorted().joined(separator: ", "))")
        throw NSError(domain: "speechdemo", code: 10)
    }
    let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
    if installed.contains(want) { return }
    log("Downloading model for \(want)…")
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
    }
}

func transcribe(path: String, localeID: String) async throws {
    let locale = Locale(identifier: localeID)
    let transcriber = SpeechTranscriber(
        locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    try await ensureModel(for: transcriber, locale: locale)

    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)

    var transcript = AttributedString("")
    for try await result in transcriber.results { transcript += result.text }
    print(String(transcript.characters))
}

let args = CommandLine.arguments
guard args.count >= 2 else { log("usage: speechdemo <audio-file> [locale-id]"); exit(2) }
let localeID = args.count >= 3 ? args[2] : "en-US"
do { try await transcribe(path: args[1], localeID: localeID) }
catch { log("Error: \(error)"); exit(1) }
```

Run it:

```bash
swift build
# WAV / M4A / CAF / AIFF that Core Audio can open:
./.build/debug/speechdemo /path/to/audio.wav en-US
./.build/debug/speechdemo /path/to/audio.wav zh-CN
```

### Live microphone

For always-on mic capture, follow `Swabble/Sources/SwabbleCore/Speech/SpeechPipeline.swift`:
install an `AVAudioEngine` input tap, convert each buffer to
`SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith:)`, yield `AnalyzerInput` into an
`AsyncStream`, `analyzer.start(inputSequence:)`, and consume `transcriber.results`.

## Common errors and limits

- **`ExtAudioFileOpenURL` fails, code `1954115647` (`'typ?'`).** `AVAudioFile` can't open
  the container/codec. **WebM/Opus** (common from browser `MediaRecorder`, sometimes
  mislabeled `.m4a`) is *not* supported — inspect with `file`/`ffprobe`, then transcode:
  ```bash
  ffmpeg -i input.webm -ac 1 -ar 16000 -c:a pcm_s16le output.wav
  ```
  Core Audio reads WAV/CAF/AIFF/ALAC/AAC-in-M4A fine. This was the exact failure hit while
  writing this doc — the "`.m4a`" attachment was really WebM/Opus.
- **`'... is only available in macOS 26.0 or newer'` at build time.** Missing availability
  annotation, or SwiftPM platform floor below `.v26`. See [Requirements](#requirements).
- **Empty transcript.** Usually a locale mismatch (e.g. Chinese audio with `en-US`) or
  silent/too-quiet audio. Pass the correct BCP-47 locale.
- **Authorization denied / no prompt.** Missing `NSSpeechRecognitionUsageDescription`, or
  authorization never requested. In CLI/agent contexts the TCC prompt may not appear —
  grant it once via a UI-bearing run, or file transcription of owned audio.
- **First run is slow.** The per-locale model download happens on first use; gate the UI
  on `request.progress`.
- **Not every `SFSpeechRecognizer` locale is supported.** Query
  `SpeechTranscriber.supportedLocales` at runtime rather than assuming.

## Verification steps

1. `sw_vers` → macOS 26+; `swift --version` → 6.2+.
2. Create the package above; `swift build` succeeds.
3. Run against a real recording. Observed result (27 s Mandarin voice memo, `zh-CN`,
   after automatic model download):
   > 嗯，去试一下这个哦 API吧，然后做一个 demo出来，然后待是放到我网页上就是放的。本地上，然后我待会看一下这个 demo到底效果咋样？如果不好弄的话，嗯，看看待会儿有没有搞一个技术文档，我去 LOS那边创建一下好吧。然后同学把这个玩意加到我们的那个知识库里去

   Accurate and punctuated on-device, no network at transcription time (note `iOS` was
   mis-heard as "LOS", a minor domain-term error).

## When to reach for it

- **Use SpeechAnalyzer** for new macOS 26 / iOS 26 targets wanting local, private,
  streaming or batch transcription with modern async APIs.
- **Consider Whisper (whisper.cpp / MLX)** if you must support older OS versions, need
  locales Apple doesn't ship, or want full control over the model.
- **In this repo:** `Swabble` already wires both the live-mic and file paths — reuse it as
  the reference rather than re-deriving the pipeline.
