# Deployment Guide — OpenClaw Windows

## CI Artifacts

Each push to `main` or a tagged release triggers two GitHub Actions workflows:
- **ci-x64.yml** — builds, tests, and packages `OpenClawWindows_x64.msix`
- **ci-arm64.yml** — builds and packages `OpenClawWindows_arm64.msix`

Artifacts are available under **Actions → Artifacts** for CI builds,
and under **Releases** for tagged releases (`v*.*.*`).

## Building Locally

```powershell
# Prerequisites: .NET 10 SDK, Windows App SDK 1.8

cd openclaw/apps/windows

# Restore NuGet packages
dotnet restore

# Build x64 Release
dotnet build -c Release -r win-x64 -p:Platform=x64

# Build ARM64 Release
dotnet build -c Release -r win-arm64 -p:Platform=ARM64

# Run tests
dotnet test tests/OpenClawWindows.Tests.csproj -c Release -p:Platform=x64

# Package MSIX x64
dotnet build OpenClawWindows.csproj -c Release -r win-x64 -p:Platform=x64 -p:PackageMsix=true

# Package MSIX ARM64
dotnet build OpenClawWindows.csproj -c Release -r win-arm64 -p:Platform=ARM64 -p:PackageMsix=true
```

## Code Signing

### Production (Azure Trusted Signing)

Release artifacts are signed via [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/).
The `release.yml` workflow signs both MSIX packages on every `v*.*.*` tag using the
`azure/trusted-signing-action` action.

**Required GitHub Actions secrets:**

| Secret | Description |
|--------|-------------|
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | Service principal client ID |
| `AZURE_CLIENT_SECRET` | Service principal client secret |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | Trusted Signing endpoint (e.g. `https://wus2.codesigning.azure.net/`) |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | Certificate profile name |

**Setup steps:**
1. Create a Trusted Signing resource in Azure Portal
2. Create a certificate profile (identity verification required)
3. Create a service principal with `Trusted Signing Certificate Profile Signer` role
4. Add the secrets above to the GitHub repository settings

### Development (self-signed)

```powershell
# Generate dev cert (one time)
$cert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject "CN=OpenClaw" `
  -KeyUsage DigitalSignature `
  -FriendlyName "OpenClaw Dev" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")

# Sign MSIX
signtool sign /fd SHA256 /sha1 $cert.Thumbprint AppPackages\*\*.msix
```

## Auto-Update Path

OpenClaw Windows uses Windows Package Manager (winget) or direct MSIX re-install for updates:

```powershell
# Manual update: install over existing installation
Add-AppxPackage -ForceApplicationShutdown OpenClawWindows_x64.msix
```

For automatic updates, a future release will integrate Sparkle for Windows (WinSparkle) or MS Store submission.

## App Data Locations

| Data | Path |
|------|------|
| Settings | `%APPDATA%\OpenClaw\settings.json` |
| Logs | `%APPDATA%\OpenClaw\logs\openclaw-YYYYMMDD.log` |
| Key storage | DPAPI (CurrentUser) via `CryptProtectData` |

## MSIX Capabilities Declared

The `Package.appxmanifest` declares these Windows capabilities:

| Capability | Required For |
|-----------|--------------|
| `webcam` | camera.snap, camera.clip |
| `microphone` | Talk Mode, Voice Wake |
| `location` | location.get |
| `picturesLibrary` | Canvas snapshot save |
| `internetClient` | WebSocket gateway connection |
| `privateNetworkClientServer` | Local gateway on LAN |

## Environment Variables

OpenClaw Windows reads no environment variables at runtime — all configuration is via `%APPDATA%\OpenClaw\settings.json`.

For development overrides, set these before launching:

| Variable | Effect |
|----------|--------|
| `OPENCLAW_GATEWAY_URI` | Override default gateway URI |
| `OPENCLAW_LOG_LEVEL` | Override log level (Verbose, Debug, Information, Warning, Error) |
| `FSCHECK_PROFILE` | FsCheck iteration profile for tests (ci, dev, thorough) |
