# Quick Start — OpenClaw Windows

Get OpenClaw Windows running in 5 minutes.

## Prerequisites

- Windows 10 version 19041 (Build 2004) or later (Windows 11 recommended)
- [Windows App SDK 1.6 Runtime](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads)
- An OpenClaw gateway running locally (WSL or remote)

## Install from MSIX (recommended)

```powershell
# 1. Download the latest release from GitHub Releases
#    OpenClawWindows_x64.msix  (Intel/AMD)
#    OpenClawWindows_arm64.msix (ARM / Snapdragon)

# 2. Install (sideload — no Store required)
Add-AppxPackage OpenClawWindows_x64.msix
```

If Windows complains about the certificate, install the dev cert first:

```powershell
# Install self-signed dev certificate (dev builds only)
Import-Certificate -FilePath packaging\dev.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

## First Launch

1. OpenClaw appears in the system tray (bottom-right notification area)
2. Right-click → **Settings** → **General** → enter your gateway URI: `ws://localhost:18789` (or your gateway address)
3. The tray icon turns green when connected

## Pairing (first time)

1. Tray icon → **Pair new gateway**
2. Approve the pairing request in your OpenClaw app / gateway admin

## Verify Connection

Right-click tray icon → the **Sessions** section should list active sessions when an agent is connected.

## Run from source (development)

```powershell
# Requires: Visual Studio 2022 17.8+ or .NET 10 SDK + Windows App SDK workload

git clone https://github.com/openclaw/openclaw
cd openclaw/apps/windows

dotnet restore
dotnet build -c Debug
# Launch from Visual Studio with F5, or:
dotnet run --project OpenClawWindows.csproj
```

## Run tests

```powershell
dotnet test tests/OpenClawWindows.Tests.csproj -v normal
```

## Common Issues

| Issue | Solution |
|-------|----------|
| "App not installed" error | Ensure Windows App SDK Runtime 1.6 is installed |
| Tray icon missing | Check task manager — OpenClawWindows.exe should be running |
| "Certificate not trusted" | Install dev cert (see above) or use a signed build |
| Gateway not connecting | Verify URI in Settings → General; check firewall allows ws:// |
| Camera permission denied | Settings → Privacy → Camera → enable for OpenClaw Windows |

## Next Steps

- Read [DEPLOYMENT.md](DEPLOYMENT.md) for CI artifacts and signing setup
- See [Known Issues](KNOWN_ISSUES.md) for SPIKEs and workarounds
