---
summary: "Running Clawdbot under Nix (config, state, and packaging expectations)"
read_when:
  - Building Clawdbot with Nix
  - Debugging Nix-mode behavior
---
# Nix mode

Clawdbot supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.
Enable it by exporting:

```
CLAWDBOT_NIX_MODE=1
```

On macOS, the GUI app does not automatically inherit shell env vars. You can
also enable Nix mode via defaults:

```
defaults write com.clawdbot.mac clawdbot.nixMode -bool true
```

## Config + state paths

Clawdbot reads JSON5 config from `CLAWDBOT_CONFIG_PATH` and stores mutable data in `CLAWDBOT_STATE_DIR`.

- `CLAWDBOT_STATE_DIR` (default: `~/.clawdbot`)
- `CLAWDBOT_CONFIG_PATH` (default: `$CLAWDBOT_STATE_DIR/clawdbot.json`)

When running under Nix, set these explicitly to Nix-managed locations so runtime state and config
stay out of the immutable store.

## Runtime behavior in Nix mode

- Auto-install and self-mutation flows should be disabled.
- Missing dependencies should surface Nix-specific remediation messages.
- UI surfaces a read-only Nix mode banner when present.

## Packaging note (macOS)

The macOS packaging flow expects a stable Info.plist template at:

```
apps/macos/Sources/Clawdbot/Resources/Info.plist
```

`scripts/package-mac-app.sh` copies this template into the app bundle and patches dynamic fields
(bundle ID, version/build, Git SHA, Sparkle keys). This keeps the plist deterministic for SwiftPM
packaging and Nix builds (which do not rely on a full Xcode toolchain).
