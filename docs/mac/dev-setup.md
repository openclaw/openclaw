---
summary: "Setup guide for developers working on the Clawdis macOS app"
read_when:
  - Setting up the macOS development environment
---
# macOS Developer Setup

This guide covers the necessary steps to build and run the Clawdis macOS application from source.

## Prerequisites

Before building the app, ensure you have the following installed:

1.  **Xcode 26.2+**: Required for Swift development.
2.  **Node.js & pnpm**: Required for the gateway and CLI components.
3.  **Bun**: Required to package the embedded gateway relay.
    ```bash
    curl -fsSL https://bun.sh/install | bash
    ```

## 1. Initialize Submodules

Clawdis depends on several submodules (like `Peekaboo`). You must initialize these recursively:

```bash
git submodule update --init --recursive
```

## 2. Install Dependencies

Install the project-wide dependencies:

```bash
pnpm install
```

## 3. Build and Package the App

To build the macOS app and package it into `dist/Clawdis.app`, run:

```bash
./scripts/package-mac-app.sh
```

If you don't have an Apple Developer ID certificate, the script will automatically use **ad-hoc signing** (`-`). 

> **Note**: Ad-hoc signed apps may trigger security prompts. If the app crashes immediately with "Abort trap 6", see the [Troubleshooting](#troubleshooting) section.

## 4. Install the CLI Helper

The macOS app requires a symlink named `clawdis` in `/usr/local/bin` or `/opt/homebrew/bin` to manage background tasks.

**To install it:**
1.  Open the Clawdis app.
2.  Go to the **General** settings tab.
3.  Click **"Install CLI helper"** (requires administrator privileges).

Alternatively, you can manually link it from your Admin account:
```bash
sudo ln -sf "/Users/$(whoami)/clawdis/dist/Clawdis.app/Contents/Resources/Relay/clawdis" /usr/local/bin/clawdis
```

## Troubleshooting

### App Crashes on Permission Grant
If the app crashes when you try to allow **Speech Recognition** or **Microphone** access, it may be due to a corrupted TCC cache or signature mismatch.

**Fix:**
1. Reset the TCC permissions:
   ```bash
   tccutil reset All com.clawdis.mac.debug
   ```
2. If that fails, change the `BUNDLE_ID` temporarily in `scripts/package-mac-app.sh` to force a "clean slate" from macOS.

### Gateway "Starting..." indefinitely
If the gateway status stays on "Starting...", check if a zombie process is holding the port:

```bash
lsof -nP -i :18789
```
Kill any existing `node` or `clawdis` processes listening on that port and restart the app.
