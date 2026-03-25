# OpenClaw Windows

> Native Windows desktop node for the OpenClaw AI agent ecosystem — 1:1 functional parity with macOS.

## Features

- **Gateway connection** — Persistent WebSocket to OpenClaw gateway with automatic reconnection and ed25519 auth
- **System tray** — Dynamic tray icon with session status, usage metrics, and node list
- **canvas.\*** — Full WebView2 canvas support: present, hide, navigate, eval, snapshot, a2ui bridge
- **camera.snap / camera.clip** — JPEG snapshots and MP4 clips via Windows.Media.Capture
- **screen.record** — Screen recording via Windows.Graphics.Capture + FFmpeg mux
- **camera.list** — Enumerate available cameras with WinRT device info
- **system.run** — Shell command execution with exec-approval IPC and allowlist enforcement
- **system.notify** — Native Windows toast notifications via WinRT
- **location.get** — GPS/Wi-Fi geolocation via Windows.Devices.Geolocation
- **Onboarding wizard** — 6-step pairing wizard for first-time setup
- **Voice Wake** — Hotword detection via Porcupine (stub in MVP — see [Known Issues](KNOWN_ISSUES.md))
- **Talk Mode** — STT+TTS via Windows.Media.SpeechRecognition / SpeechSynthesis
- **Autostart** — Survives reboot via Windows Task Scheduler

## Build & Run

Prerequisites: [.NET 10 SDK](https://dotnet.microsoft.com/download), Windows 10 1903+.

```bash
# Restore, build, and run tests
dotnet restore
dotnet build OpenClawWindows.csproj -c Release -p:Platform=x64
dotnet test tests/OpenClawWindows.Tests.csproj -c Release -p:Platform=x64 --no-build

# Package as MSIX (sideload)
dotnet build OpenClawWindows.csproj -c Release -r win-x64 -p:Platform=x64 -p:PackageMsix=true
```

The MSIX output lands in `AppPackages/`.

## Quick Links

- [Quick Start Guide](QUICKSTART.md) — Install and connect in 5 minutes
- [Deployment Guide](DEPLOYMENT.md) — CI artifacts, signing, update path
- [Rollback Procedures](ROLLBACK.md) — Rollback to a previous MSIX version
- [Architecture Decisions](docs/adr/) — Key design decisions
- [Known Issues](KNOWN_ISSUES.md) — SPIKEs and open questions

## Tech Stack

| Layer          | Technology                                              |
|----------------|---------------------------------------------------------|
| Language       | C# 13 / .NET 10                                        |
| UI             | WinUI 3 / Windows App SDK 1.8                          |
| Architecture   | Hexagonal Modular Monolith + MVVM                      |
| Packaging      | MSIX (x64 + ARM64)                                     |
| Gateway        | System.Net.WebSockets + Polly reconnect                |
| IPC            | NamedPipeServerStream (exec approvals)                  |
| Camera / Screen| Windows.Media.Capture / Windows.Graphics.Capture       |
| Audio / STT    | NAudio + Windows.Media.SpeechRecognition               |
| Canvas         | Microsoft.Web.WebView2                                 |
| Persistence    | System.Text.Json → %APPDATA%\OpenClaw\settings.json    |
| DI             | Microsoft.Extensions.Hosting                           |
| Logging        | Serilog → %APPDATA%\OpenClaw\logs\                     |

## Known Limitations (MVP)

- **SPIKE-003** (mDNS): Gateway discovery stub — manual URI entry works; mDNS auto-discovery pending.
- **SPIKE-004** (Porcupine): Voice Wake hotword is a stub — Talk Mode STT works.
- **OQ-002** (canvas eval): `canvas.eval` taint flow documented; sandboxing review required.

See [Known Issues](KNOWN_ISSUES.md) for details.

## License

MIT — see [LICENSE](../../../../LICENSE) at repo root.
