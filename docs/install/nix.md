---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Install OpenClaw declaratively with Nix"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want reproducible, rollback-able installs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You're already using Nix/NixOS/Home Manager（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want everything pinned and managed declaratively（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Nix"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nix Installation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The recommended way to run OpenClaw with Nix is via **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — a batteries-included Home Manager module.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Paste this to your AI agent (Claude, Cursor, etc.):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```text（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
I want to set up nix-openclaw on my Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Repository: github:openclaw/nix-openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What I need you to do:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check if Determinate Nix is installed (if not, install it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Fill in the template placeholders and run home-manager switch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Verify: launchd running, bot responds to messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reference the nix-openclaw README for module options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **📦 Full guide: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> The nix-openclaw repo is the source of truth for Nix installation. This page is just a quick overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What you get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway + macOS app + tools (whisper, spotify, cameras) — all pinned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Launchd service that survives reboots（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugin system with declarative config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Instant rollback: `home-manager switch --rollback`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Nix Mode Runtime Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When `OPENCLAW_NIX_MODE=1` is set (automatic with nix-openclaw):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it by exporting:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_NIX_MODE=1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On macOS, the GUI app does not automatically inherit shell env vars. You can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
also enable Nix mode via defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
defaults write bot.molt.mac openclaw.nixMode -bool true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config + state paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw reads JSON5 config from `OPENCLAW_CONFIG_PATH` and stores mutable data in `OPENCLAW_STATE_DIR`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When needed, you can also set `OPENCLAW_HOME` to control the base home directory used for internal path resolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_HOME` (default precedence: `HOME` / `USERPROFILE` / `os.homedir()`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_STATE_DIR` (default: `~/.openclaw`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `OPENCLAW_CONFIG_PATH` (default: `$OPENCLAW_STATE_DIR/openclaw.json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When running under Nix, set these explicitly to Nix-managed locations so runtime state and config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stay out of the immutable store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Runtime behavior in Nix mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-install and self-mutation flows are disabled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Missing dependencies surface Nix-specific remediation messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI surfaces a read-only Nix mode banner when present（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Packaging note (macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS packaging flow expects a stable Info.plist template at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
apps/macos/Sources/OpenClaw/Resources/Info.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) copies this template into the app bundle and patches dynamic fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(bundle ID, version/build, Git SHA, Sparkle keys). This keeps the plist deterministic for SwiftPM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
packaging and Nix builds (which do not rely on a full Xcode toolchain).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — full setup guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Wizard](/start/wizard) — non-Nix CLI setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Docker](/install/docker) — containerized setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
