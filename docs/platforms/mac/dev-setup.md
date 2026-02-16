---
summary: "Setup guide for developers working on the OpenClaw macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS Dev Setup"
---

# macOS Developer Setup

This guide covers the necessary steps to build and run the OpenClaw macOS application from source.

## Prerequisites

Before building the app, ensure you have the following installed:

1. **Xcode 26.2+**: Required for Swift development.
2. **Node.js 22+ & pnpm**: Required for the gateway, CLI, and packaging scripts.

## 1. Install Dependencies

Install the project-wide dependencies:

```bash
pnpm install
```

## 2. Build and Package the App

To build the macOS app and package it into `dist/OpenClaw.app`, run:

```bash
./scripts/package-mac-app.sh
```

If you don't have an Apple Developer ID certificate, the script will automatically use **ad-hoc signing** (`-`).

For dev run modes, signing flags, and Team ID troubleshooting, see the macOS app README:
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> **Note**: Ad-hoc signed apps may trigger security prompts. If the app crashes immediately with "Abort trap 6", see the [Troubleshooting](#troubleshooting) section.

## 3. Install the CLI

The macOS app needs the `openclaw` CLI to manage the gateway.

**Option A: Via onboarding (recommended)**

Launch the app — the onboarding "Install OpenClaw" page runs the standalone installer automatically.

**Option B: Standalone installer**

```bash
curl -fsSL https://openclaw.ai/install-cli.sh | bash
```

Installs to `~/.openclaw/` (Node.js + CLI, no sudo). The binary is at `~/.openclaw/bin/openclaw`.

**Option C: Global npm install (if you already have Node.js 22+)**

```bash
npm install -g openclaw@latest
```

> **Note:** The standalone installer does not add `~/.openclaw/bin` to your PATH. The macOS app finds the binary directly. To use it from Terminal:
>
> ```bash
> echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
> ```

## 4. Run Tests

```bash
cd apps/macos && swift test
```

## 5. Reset App State

### Reset Onboarding

Re-run onboarding without removing the CLI or gateway config (useful after UI/onboarding changes):

```bash
scripts/restart-mac.sh --reset-onboarding
```

This kills the running app and clears onboarding/UI state (UserDefaults). Launch the app manually afterward to re-run onboarding.
It does **not** remove `~/.openclaw/openclaw.json` (gateway config persists across resets).

### Full Reset

Wipe everything (onboarding, gateway config, CLI install) and start the app from scratch:

```bash
scripts/restart-mac.sh --full-reset
```

This kills the running app, removes the gateway service, `~/.openclaw`, and onboarding state. Launch the app manually afterward — it will behave as if on a brand new Mac.

## Troubleshooting

### Build Fails: Toolchain or SDK Mismatch

The macOS app build expects the latest macOS SDK and Swift 6.2 toolchain.

**System dependencies (required):**

- **Latest macOS version available in Software Update** (required by Xcode 26.2 SDKs)
- **Xcode 26.2** (Swift 6.2 toolchain)

**Checks:**

```bash
xcodebuild -version
xcrun swift --version
```

If versions don’t match, update macOS/Xcode and re-run the build.

### App Crashes on Permission Grant

If the app crashes when you try to allow **Speech Recognition** or **Microphone** access, it may be due to a corrupted TCC cache or signature mismatch.

**Fix:**

1. Reset the TCC permissions:

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. If that fails, change the `BUNDLE_ID` temporarily in [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) to force a "clean slate" from macOS.

### Gateway "Starting..." indefinitely

If the gateway status stays on "Starting...", check if a zombie process is holding the port:

```bash
~/.openclaw/bin/openclaw gateway status
~/.openclaw/bin/openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run is holding the port, stop that process (Ctrl+C). As a last resort, kill the PID you found above.
