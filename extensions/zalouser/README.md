# @openclaw/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw extension for Zalo Personal Account messaging via [zca-cli](https://zca-cli.dev).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Warning:** Using Zalo automation may result in account suspension or ban. Use at your own risk. This is an unofficial integration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Channel Plugin Integration**: Appears in onboarding wizard with QR login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway Integration**: Real-time message listening via the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-Account Support**: Manage multiple Zalo personal accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI Commands**: Full command-line interface for messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Agent Tool**: AI agent integration for automated messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install `zca` CLI and ensure it's in your PATH:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**macOS / Linux:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.zca-cli.dev/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or with custom install directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ZCA_INSTALL_DIR=~/.local/bin curl -fsSL https://get.zca-cli.dev/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install specific version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.zca-cli.dev/install.sh | bash -s v1.0.0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.zca-cli.dev/install.sh | bash -s uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Windows (PowerShell):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
irm https://get.zca-cli.dev/install.ps1 | iex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or with custom install directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$env:ZCA_INSTALL_DIR = "C:\Tools\zca"; irm https://get.zca-cli.dev/install.ps1 | iex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Install specific version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
iex "& { $(irm https://get.zca-cli.dev/install.ps1) } -Version v1.0.0"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
iex "& { $(irm https://get.zca-cli.dev/install.ps1) } -Uninstall"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Manual Download（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Download binary directly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**macOS / Linux:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://get.zca-cli.dev/latest/zca-darwin-arm64 -o zca && chmod +x zca（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Windows (PowerShell):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```powershell（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Invoke-WebRequest -Uri https://get.zca-cli.dev/latest/zca-windows-x64.exe -OutFile zca.exe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available binaries:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `zca-darwin-arm64` - macOS Apple Silicon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `zca-darwin-x64` - macOS Intel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `zca-linux-arm64` - Linux ARM64（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `zca-linux-x64` - Linux x86_64（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `zca-windows-x64.exe` - Windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [zca-cli](https://zca-cli.dev) for manual download (binaries for macOS/Linux/Windows) or building from source.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option 1: Onboarding Wizard (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Select "Zalo Personal" from channel list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Follow QR code login flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Option 2: Login (QR, on the Gateway machine)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Scan QR code with Zalo app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send a Message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel zalouser --target <threadId> --message "Hello from OpenClaw!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After onboarding, your config will include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  zalouser:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    dmPolicy: pairing # pairing | allowlist | open | disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For multi-account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  zalouser:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enabled: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaultAccount: default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        profile: default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      work:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        enabled: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        profile: work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Authentication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel zalouser              # Login via QR（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel zalouser --account work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels logout --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Directory (IDs, contacts, groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory self --channel zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory peers list --channel zalouser --query "name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups list --channel zalouser --query "work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw directory groups members --channel zalouser --group-id <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Account Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca account list      # List all profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca account current   # Show active profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca account switch <profile>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca account remove <profile>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca account label <profile> "Work Account"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel zalouser --target <threadId> --message "message"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Media (URL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel zalouser --target <threadId> --message "caption" --media-url "https://example.com/img.jpg"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Listener（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The listener runs inside the Gateway when the channel is enabled. For debugging,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use `openclaw channels logs --channel zalouser` or run `zca listen` directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Data Access（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Friends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca friend list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca friend list -j    # JSON output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca friend find "name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca friend online（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca group list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca group info <groupId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca group members <groupId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca me info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
zca me id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multi-Account Support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--profile` or `-p` to work with multiple accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels login --channel zalouser --account work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw message send --channel zalouser --account work --target <id> --message "Hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ZCA_PROFILE=work zca listen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Profile resolution order: `--profile` flag > `ZCA_PROFILE` env > default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Agent Tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The extension registers a `zalouser` tool for AI agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "action": "send",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "threadId": "123456",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "message": "Hello from AI!",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "isGroup": false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "profile": "default"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Available actions: `send`, `image`, `link`, `friends`, `groups`, `me`, `status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Login Issues:** Run `zca auth logout` then `zca auth login`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **API Errors:** Try `zca auth cache-refresh` or re-login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File Uploads:** Check size (max 100MB) and path accessibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Credits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Built on [zca-cli](https://zca-cli.dev) which uses [zca-js](https://github.com/RFS-ADRENO/zca-js).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
