---
summary: "End-to-end install flow for the OpenClaw macOS app on a fresh Mac, including what gets installed, disk layout, and uninstall"
read_when:
  - Setting up OpenClaw on a fresh Mac
  - Understanding what the macOS app installer does
  - Uninstalling OpenClaw from macOS
title: "Fresh Mac Install Flow"
---

# Fresh Mac Install Flow

Complete flow on a **completely fresh Mac** (nothing installed — no Node.js, no Homebrew, no CLI).

## Step-by-step: Fresh Mac → OpenClaw running

### 1. User downloads and opens OpenClaw.app

Drag to `/Applications`.

### 2. Onboarding starts automatically

| Page | Name                             | What happens                                           |
| ---- | -------------------------------- | ------------------------------------------------------ |
| 1    | **Welcome**                      | Intro text, security notice                            |
| 2    | **Install OpenClaw**             | CLI install button, gateway toggle, troubleshoot/reset |
| 3    | **Choose your Gateway**          | Pick "This Mac" / remote / discovered gateway          |
| 4+   | Wizard, Permissions, Chat, Ready | Provider setup, accessibility permissions, first chat  |

### 3. Install OpenClaw page (page 2 in flow)

The Install page has three sections:

**CLI install** — User clicks "Install". The app runs behind the scenes:

```bash
curl -fsSL https://openclaw.bot/install-cli.sh | bash -s -- --json --no-onboard --prefix ~/.openclaw --version 'latest'
```

This script handles **everything** with zero prerequisites:

- Downloads and installs **Node.js 22+** → `~/.openclaw/tools/node/`
- Installs **openclaw CLI** via npm → `~/.openclaw/lib/node_modules/openclaw/`
- Creates **wrapper binary** → `~/.openclaw/bin/openclaw`

No Homebrew, no system Node, no `sudo` needed.

> **Note:** The installer does not add `~/.openclaw/bin` to your shell PATH. The macOS app finds the binary directly. To use `openclaw` from Terminal, add it manually:
>
> ```bash
> echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc
> ```

**Gateway toggle** — "Start gateway after install" is enabled by default. When the CLI install finishes, the app automatically chains into gateway startup (see step 4 below). The user can disable this toggle to install the CLI only and start the gateway later.

**Troubleshooting / Reset** — A "Reset Installation" button (with confirmation alert) performs a full cleanup:

- Stops the gateway process and bootout the launchd service
- Removes the launchd plist
- Deletes `~/.openclaw/` (CLI, config, sessions, credentials)
- Clears device auth tokens (stored outside `~/.openclaw/` in Application Support)
- Resets UI state so the Install page is ready for a fresh install

### 4. Gateway starts automatically

When the gateway toggle is on (default), the app chains CLI install → gateway startup in one flow:

1. **Pre-selects "This Mac"** — sets `connectionMode = .local` and writes `gateway.mode=local` directly to `~/.openclaw/openclaw.json` (the gateway refuses to start without it).

2. **Stops any existing gateway** — if a gateway is already running (reinstall scenario), the app calls `GatewayProcessManager.stop()` and waits 1.5s for launchd teardown before restarting with the fresh binary.

3. **Triggers gateway start** — calls `GatewayProcessManager.setActive(true)`, which:
   - First tries `attachExistingGatewayIfAvailable()` — checks if a gateway is already listening on the port (3 health check retries with 250ms backoff). If a listener is found but auth fails (e.g. device token mismatch after a reset), still treats it as attached (auth resolves via the control channel after pairing).
   - If no existing gateway, runs `enableLaunchdGateway()`:
     - Resolves the gateway command via `GatewayEnvironment.resolveGatewayCommand()`
     - Runs: `~/.openclaw/bin/openclaw gateway install --force --port 18789 --runtime node --json`
     - Installs a **launchd plist** (`ai.openclaw.gateway`) with `KeepAlive=true` so the gateway auto-starts on login
     - Waits up to 15s for the port to become reachable (TCP connect check, not authenticated)

4. **Polling loop** — the Install page shows a live counter ("Starting gateway… (Ns)") and polls `GatewayProcessManager.status` every second for up to 60s:
   - `.running` or `.attachedExisting` → success, shows "Gateway running" with green checkmark
   - `.failed` with a listener present (`existingGatewayDetails != nil`) → treated as success (auth-pending scenario)
   - Timeout → one final TCP port check as fallback
   - The polling loop only reads the synchronous `mgr.status` property — no async subprocess calls — to avoid `@MainActor` contention that would stall the counter

**Typical gateway startup times:**

- Fresh install on Apple Silicon: 15–30s (cold Node.js start after launchd plist install)
- Subsequent starts: 5–10s
- Older hardware: up to 45s

### 5. "This Mac" auto-selected on Gateway page

When the user advances to the "Choose your Gateway" page, the app checks if the CLI was installed and the gateway toggle was on. If so, it auto-selects "This Mac" (local mode). If the CLI is gone but local mode is still selected, it resets to unconfigured.

### 6. User finishes onboarding

Sets up provider (Anthropic OAuth, API key, etc.), grants permissions, done.

## Reinstall behavior

Clicking "Reinstall" on the Install page (when the CLI is already installed):

1. Re-runs the CLI installer (downloads latest version)
2. If the gateway was already running, **stops it first** (calls `stop()` + 1.5s teardown) so the restarted process picks up the freshly installed binary
3. Starts the gateway again via the same flow as fresh install

## Navigation blocking

While CLI install, gateway startup, or reset is in progress (`isInstallBusy`):

- The "Next" button is disabled (`canAdvance = false`)
- The "Back" button is disabled
- Page dots are dimmed and non-interactive
- The Install/Reinstall button and Reset button are disabled

This prevents the user from navigating away mid-operation.

## What's on disk after install

```
~/.openclaw/
├── bin/openclaw                          # CLI wrapper
├── tools/node/bin/node                   # Bundled Node.js 22+
├── lib/node_modules/openclaw/            # CLI package
├── openclaw.json                         # Config (gateway.mode, etc.)
├── credentials/                          # Provider auth (OAuth tokens)
├── workspace/                            # Agent files
└── sessions/                             # Chat sessions

~/Library/Application Support/OpenClaw/
└── identity/device-auth.json             # Device auth tokens (pairing)

~/Library/LaunchAgents/
└── ai.openclaw.gateway.plist             # Auto-start gateway on login

/Applications/
└── OpenClaw.app                          # Menu bar app
```

> **Note:** Device auth tokens are stored in `~/Library/Application Support/OpenClaw/identity/` (outside `~/.openclaw/`). The in-app "Reset Installation" button clears both locations. Manual cleanup requires deleting both.

## Uninstall

How to completely remove OpenClaw from your Mac.

### If the CLI is still installed (standalone installer)

The uninstall command stops the gateway, removes the launchd service, and cleans up workspace/config. However, it cannot fully remove `~/.openclaw` because the CLI runs from inside that directory. Remove it manually after:

```bash
~/.openclaw/bin/openclaw uninstall --all --yes --non-interactive
rm -rf ~/.openclaw
rm -rf /Applications/OpenClaw.app
```

### Using npx (CLI already removed but Node.js available)

If the CLI is gone but you still have Node.js/npm:

```bash
npx -y openclaw uninstall --all --yes --non-interactive
rm -rf ~/.openclaw
rm -rf /Applications/OpenClaw.app
```

This downloads a temporary copy of the CLI and runs the full uninstall (stops gateway, removes service, deletes state).

### Manual removal (CLI gone, no Node.js)

For a completely fresh Mac or when no tools are available — pure shell commands, no dependencies:

```bash
# Stop and remove the launchd service
launchctl bootout gui/$UID/ai.openclaw.gateway 2>/dev/null
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# Delete all state, config, and workspace
rm -rf ~/.openclaw

# Remove device auth tokens (stored outside ~/.openclaw)
rm -rf ~/Library/Application\ Support/OpenClaw/identity

# Remove the CLI (if installed via npm/pnpm/bun globally)
npm rm -g openclaw   # or: pnpm remove -g openclaw / bun remove -g openclaw

# Remove the macOS app
rm -rf /Applications/OpenClaw.app

# Clean PATH entry from shell config
grep -n 'openclaw' ~/.zshrc ~/.bashrc ~/.profile 2>/dev/null
# (then delete the matching line)
```

### What gets removed by `rm -rf ~/.openclaw`

The standalone installer (`install-cli.sh`) installs everything under `~/.openclaw/`:

| Component              | Path                                               | Removed?           |
| ---------------------- | -------------------------------------------------- | ------------------ |
| CLI wrapper script     | `~/.openclaw/bin/openclaw`                         | ✅                 |
| Node.js 22+ (bundled)  | `~/.openclaw/tools/node/`                          | ✅                 |
| CLI npm package        | `~/.openclaw/lib/node_modules/openclaw/`           | ✅                 |
| Gateway state & config | `~/.openclaw/openclaw.json`, sessions, etc.        | ✅                 |
| Agent workspace        | `~/.openclaw/workspace/`                           | ✅                 |
| Credentials            | `~/.openclaw/credentials/`                         | ✅                 |
| Device auth tokens     | `~/Library/Application Support/OpenClaw/identity/` | ❌ (separate path) |

To also remove device auth tokens: `rm -rf ~/Library/Application\ Support/OpenClaw/identity`

### PATH setup (optional)

The standalone installer does **not** modify shell profiles. To use `openclaw` from Terminal, add the PATH manually:

```bash
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

The macOS app does not need this — it finds `~/.openclaw/bin/openclaw` directly.

If you added this line and later uninstall, remove it:

```bash
grep -n 'openclaw' ~/.zshrc 2>/dev/null
```

Then delete the matching line.

## Key point

For a fresh/unexperienced user, they only need to:

1. Open the app
2. Click "Install" on the Install page (gateway starts automatically)
3. Click "Next" through the remaining pages

Everything else (Node.js, CLI, gateway service, launchd plist) is handled automatically with no terminal knowledge required.

If something goes wrong (broken previous install, stale gateway, auth issues), the "Reset Installation" button on the Install page wipes everything and lets the user install fresh — without needing to touch Terminal.
