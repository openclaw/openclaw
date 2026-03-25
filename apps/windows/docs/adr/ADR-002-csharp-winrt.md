# ADR-002: C# / .NET 10 + WinRT as Implementation Platform

## Status
Accepted

## Context

OpenClaw requires a Windows native node app with 1:1 parity with the macOS Swift app. C# was selected as the preferred implementation language after evaluating available prototypes. Alternative: Rust/Tauri.

## Decision

Implement in **C# 13 / .NET 10** with **WinRT APIs** via Windows App SDK 1.8.

The macOS → Windows API mapping is nearly mechanical:

| macOS API (Swift) | Windows API (C#) |
|-------------------|-----------------|
| `AVCaptureSession` | `Windows.Media.Capture.MediaCapture` |
| `ScreenCaptureKit` | `Windows.Graphics.Capture.GraphicsCaptureSession` |
| `SFSpeechRecognizer` | `Windows.Media.SpeechRecognition.SpeechRecognizer` |
| `AVSpeechSynthesizer` | `Windows.Media.SpeechSynthesis.SpeechSynthesizer` |
| `CLLocationManager` | `Windows.Devices.Geolocation.Geolocator` |
| `NSTask` + `Process` | `System.Diagnostics.Process` (ArgumentList) |

## Consequences

### Positive
- WinRT APIs designed for C# — mapping is almost mechanical from Swift
- `async/await` in C# nearly identical to Swift `actor` + `async/await`
- Full MSIX packaging, code signing, and Store submission support
- Strong typing, analyzers, and test tooling (xUnit, FluentAssertions, FsCheck)

### Negative
- WinRT `async` patterns require `ConfigureAwait(false)` care
- Ed25519 signing not natively in BCL — resolved via NSec + DPAPI-backed key storage

### Risks
- WinUI 3 is still evolving — some APIs may change between Windows App SDK releases

## Traceability
- Phase: 0
- Related: TDR-001, TDR-002, ADR-001, R-003
