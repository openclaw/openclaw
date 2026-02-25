---
summary: "Install Activi declaratively with Nix"
read_when:
  - You want reproducible, rollback-able installs
  - You're already using Nix/NixOS/Home Manager
  - You want everything pinned and managed declaratively
title: "Nix"
---

# Nix Installation

The recommended way to run Activi with Nix is via **[nix-activi](https://github.com/activi/nix-activi)** — a batteries-included Home Manager module.

## Quick Start

Paste this to your AI agent (Claude, Cursor, etc.):

```text
I want to set up nix-activi on my Mac.
Repository: github:activi/nix-activi

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/activi-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-activi README for module options.
```

> **📦 Full guide: [github.com/activi/nix-activi](https://github.com/activi/nix-activi)**
>
> The nix-activi repo is the source of truth for Nix installation. This page is just a quick overview.

## What you get

- Gateway + macOS app + tools (whisper, spotify, cameras) — all pinned
- Launchd service that survives reboots
- Plugin system with declarative config
- Instant rollback: `home-manager switch --rollback`

---

## Nix Mode Runtime Behavior

When `ACTIVI_NIX_MODE=1` is set (automatic with nix-activi):

Activi supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.
Enable it by exporting:

```bash
ACTIVI_NIX_MODE=1
```

On macOS, the GUI app does not automatically inherit shell env vars. You can
also enable Nix mode via defaults:

```bash
defaults write bot.molt.mac activi.nixMode -bool true
```

### Config + state paths

Activi reads JSON5 config from `ACTIVI_CONFIG_PATH` and stores mutable data in `ACTIVI_STATE_DIR`.
When needed, you can also set `ACTIVI_HOME` to control the base home directory used for internal path resolution.

- `ACTIVI_HOME` (default precedence: `HOME` / `USERPROFILE` / `os.homedir()`)
- `ACTIVI_STATE_DIR` (default: `~/.activi`)
- `ACTIVI_CONFIG_PATH` (default: `$ACTIVI_STATE_DIR/activi.json`)

When running under Nix, set these explicitly to Nix-managed locations so runtime state and config
stay out of the immutable store.

### Runtime behavior in Nix mode

- Auto-install and self-mutation flows are disabled
- Missing dependencies surface Nix-specific remediation messages
- UI surfaces a read-only Nix mode banner when present

## Packaging note (macOS)

The macOS packaging flow expects a stable Info.plist template at:

```
apps/macos/Sources/Activi/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/activi/activi/blob/main/scripts/package-mac-app.sh) copies this template into the app bundle and patches dynamic fields
(bundle ID, version/build, Git SHA, Sparkle keys). This keeps the plist deterministic for SwiftPM
packaging and Nix builds (which do not rely on a full Xcode toolchain).

## Related

- [nix-activi](https://github.com/activi/nix-activi) — full setup guide
- [Wizard](/start/wizard) — non-Nix CLI setup
- [Docker](/install/docker) — containerized setup
