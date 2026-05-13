# OpenClaw Linux Companion App

A native GTK4 + Libadwaita companion app for managing and observing the local OpenClaw gateway on Ubuntu GNOME.

## What this app is

The Linux companion is a native desktop app that integrates with the local OpenClaw gateway and the user `systemd` service lifecycle.

Current foundation:
- C
- GTK4 + Libadwaita
- Ayatana/AppIndicator tray integration
- native local gateway client over HTTP + WebSocket
- `systemd --user` integration for `openclaw-gateway.service`
- gateway start / stop / restart / refresh
- integrated main-window Diagnostics section with systemd + gateway runtime state

This is still an early-stage foundation. The goal of this document is to describe the **current, tested baseline** from a clean Ubuntu machine up to a working local gateway + Linux companion flow.

## Architecture

This application uses a multiprocess design to safely bridge GTK4 and GTK3 tray integration:

1. `openclaw-linux`  
   The main application, written in GTK4 + Libadwaita. It handles:
   - `systemd --user` integration
   - local gateway connectivity
   - diagnostics and runtime state
   - application state transitions and UI

2. `openclaw-tray-helper`  
   A small GTK3 helper process that owns the Ayatana/AppIndicator tray icon and menu, avoiding GTK3/GTK4 type conflicts.

**Note:** `openclaw-tray-helper` is a private implementation detail. It is not intended as a user-facing executable.

## Supported targets

Tested/documented target flow:
- **Ubuntu 24.04 GNOME**
- **Ubuntu 26.04 GNOME**

Notes:
- Debian is still deferred.
- Ubuntu 24.04 requires Node.js from external sources for the current OpenClaw workflow.
- Ubuntu 26.04 can use distro-native `apt` packages for Node.js and npm.

## Important scope note

This README intentionally documents the **current Linux companion workflow**:
- build OpenClaw
- build the Linux companion
- launch the Linux companion at any point, including **before** OpenClaw is installed or onboarded
- run `openclaw onboard --install-daemon`
- validate the companion’s transition into the ready state

The Linux companion now supports the intended bootstrap flow centered on `openclaw onboard --install-daemon` and does **not** require stop/start or relaunch checkpoints between setup phases.

---

## Prepare Ubuntu

Use separate terminals where practical. It makes the lifecycle much easier to observe.

### 1) Install common Ubuntu packages (24.04 and 26.04)

Run as `root` or via `sudo`:

```bash
sudo apt update
sudo apt install -y \
  git \
  gcc \
  meson \
  ninja-build \
  pkg-config \
  libgtk-4-dev \
  libadwaita-1-dev \
  libayatana-appindicator3-dev \
  libjson-glib-dev \
  libsoup-3.0-dev \
  libsodium-dev \
  glib-networking
```

> `libsodium-dev` is required for the device identity (Ed25519 signing used
> by the gateway connect handshake — see
> [Device identity and pairing](#device-identity-and-pairing)).

### 2) Install Node.js via external sources (works on Ubuntu 24.04 and 26.04)

Use this path if you want the same Node.js setup on both Ubuntu releases, or if you are on Ubuntu 24.04.

Run as `openclaw` or other regular Linux user (not `root`):

```bash
# Download and install nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

# In lieu of restarting the shell:
\. "$HOME/.nvm/nvm.sh"

# Download and install Node.js:
nvm install 22

# Verify Node.js:
node -v

# Enable pnpm through Corepack:
corepack enable pnpm

# Verify pnpm:
pnpm -v
```

### 3) Install Node.js via APT (Ubuntu 26.04 only)

Ubuntu 26.04 has a convenient distro-native path:

Run as `root` or via `sudo`:

```bash
sudo apt update
sudo apt install -y nodejs npm
corepack enable
```

This path is currently a strong fit for Ubuntu 26.04 development and testing.

---

## Clone the Linux-app branch

Clone the fork/branch that contains the Linux companion work:

Run as `openclaw` or other regular Linux user (not `root`):

```bash
cd ~
git clone https://github.com/tiagonix/openclaw.git
cd ~/openclaw
git checkout feat/linux-systemd-c-gtk-companion-tray
```

---

## Build OpenClaw Gateway

From the repository root:

```bash
corepack install
pnpm install
pnpm ui:build
pnpm build
```

This builds the OpenClaw gateway and related assets needed for local testing.

---

## Build OpenClaw Linux App

From `apps/linux`:

```bash
cd apps/linux
meson setup build
meson test -C build
meson compile -C build
```

---

## Run the Linux App before OpenClaw is onboarded

From `apps/linux`:

```bash
./build/openclaw-linux
```

### What to expect

At this point, there may be no initialized local OpenClaw environment yet.

That is expected.

The Linux companion should launch cleanly **even when nothing has been installed or onboarded yet**. You can keep it open while completing bootstrap in another terminal.

You should inspect the app and diagnostics at this stage to confirm the pre-bootstrap behavior is understandable and stable.

---

## Onboard OpenClaw and install the user gateway service

In another terminal, from the repository root:

```bash
cd ~/openclaw
node openclaw.mjs onboard --install-daemon
```

Optional direct inspection:

```bash
systemctl --user status openclaw-gateway.service
journalctl --user -fu openclaw-gateway.service
```

---

## Inspect the Linux App diagnostics

If the Linux app is already open, it should detect the new config and service state without requiring a restart. Launch it again only if needed:

```bash
cd ~/openclaw/apps/linux
./build/openclaw-linux
```

At this point, the diagnostics/state should settle into a **ready** baseline for the local companion flow.

This is the current foundational checkpoint:
- OpenClaw built
- Linux app built and tested
- `openclaw onboard --install-daemon` completed
- Linux companion can observe and manage the local gateway state

---

## Tray support requirements

The app uses Ayatana AppIndicator for tray integration.

Expected Ubuntu runtime environment:
- **Ubuntu 24.04:** usually via `gnome-shell-extension-appindicator`
- **Ubuntu 26.04:** verify the installed GNOME extension packaging on the target system; some systems expose equivalent Ubuntu/GNOME extension bundles rather than a standalone package

GTK3 Ayatana deprecation warnings on newer Ubuntu releases are known for the current v1 approach.

The tray intentionally does **not** surface pairing status. When the
gateway signals `PAIRING_REQUIRED` (or any inbound pair approval is
pending on this machine), the main app window's sidebar footer shows a
dedicated **Pairing** indicator next to the Gateway and Service
indicators. See below.

---

## Device identity and pairing

The Linux companion is a first-class operator surface: it carries its
own device-bound identity, persists per-role device tokens across
reconnects, and can **approve pairing requests locally from this
machine** — via the CLI, the bootstrap window, or the in-app approval
dialog — without needing a second device. The identity and token
formats are interoperable with the other OpenClaw clients (Control UI,
macOS companion), so a token issued here is usable from any paired
surface, but nothing here requires another surface to exist.

Where it lives on disk:

```
<state dir>/identity/
├── device.json         # Ed25519 identity (mode 0600; dir 0700)
└── device-auth.json    # durable per-role device tokens (mode 0600)
```

The effective state dir is resolved via `runtime_paths.c` and normally
sits under `$OPENCLAW_STATE_DIR` or `~/.openclaw/state/<profile>`.

Handshake behavior (see `src/gateway_ws.c`, `src/gateway_protocol.c`):

- **First run on a loopback gateway:** the companion generates a fresh
  identity, signs the connect challenge with it, and the gateway silent-
  approves the local device. The returned `hello.auth.deviceToken` is
  persisted in `device-auth.json` for future reconnects.
- **Steady state:** on every reconnect the stored device token is sent
  as `auth.token`; no operator interaction is required.
- **Token mismatch repair:** on `AUTH_TOKEN_MISMATCH` the companion
  retries once with the stored token echoed in `auth.deviceToken`
  (one-shot budget per session). On success the fresh token replaces
  the old one; on `AUTH_DEVICE_TOKEN_MISMATCH` the stored token is
  cleared so the next connect rebuilds trust.
- **Remote-only or disabled silent pair:** if the gateway returns a
  `PAIRING_REQUIRED` detail code, reconnect is paused and a native
  **Pairing required** bootstrap window is presented. The window
  carries the pending request id, this machine's deviceId, and the
  canonical Linux fallback command so the operator can approve
  **locally** without leaving the box:

  ```bash
  openclaw devices pair approve <requestId>
  ```

  A copy-to-clipboard button next to the command is provided for
  terminals that don't cleanly handle selection from Adwaita. If the
  gateway did not include a request id, the window falls back to
  `openclaw devices pair list` so the operator can discover it on
  this machine. An already-paired operator surface on another OS
  (Control UI in a browser, macOS companion, …) remains an
  **optional alternate** approver. After approval — however it
  happens — pressing **Check again** resumes the WS reconnect.
- **Approving other devices from Linux:** the operator-class Linux
  companion is a first-class approver for other devices too. It
  receives `device.pair.requested` events and presents an Adwaita
  approval dialog (Approve / Reject / Later) mirroring the macOS
  `NSAlert` flow. Decisions are dispatched back to the gateway via
  `device.pair.approve` or `device.pair.reject`.
- **Cross-surface convergence:** when `device.pair.resolved` arrives
  for a request the Linux operator is currently looking at, the open
  approval dialog is dismissed silently (no decision RPC is emitted
  from this machine). Queued-but-not-yet-presented duplicates of the
  same request id are dropped on the floor. This matches the macOS
  `DevicePairingApprovalPrompter` and Control UI semantics: exactly
  one operator decision per request, regardless of where it came
  from.
- **List seed on reconnect:** every time the WS transport transitions
  to `CONNECTED`, the companion issues `device.pair.list` and enqueues
  any requests it learns about. The queue dedupes by request id so
  live events arriving in parallel with the seed don't show up twice.
- **In-app affordance:** the main window's sidebar footer shows a
  **Pairing** status row (dot + label) alongside the Gateway and
  Service indicators. Label and color are computed by the pure helper
  `pairing_status_model_build` from the same truth sources the
  Diagnostics tab reads. When the row is actionable (pairing required
  on this handshake, or one or more inbound approvals are pending
  locally) an adjacent **Open** button appears; clicking it raises the
  bootstrap window (if up) or the active approval dialog via
  `device_pair_prompter_raise()`. The tray menu does not duplicate
  this state.

Forgetting the device (e.g. to re-run first-run pairing) is a simple
filesystem operation:

```bash
rm -rf "$(openclaw doctor --print-state-dir)/identity"
# or, in the default layout:
rm -rf ~/.openclaw/state/<profile>/identity
```

The next connect will regenerate a fresh identity and re-enter the
silent-pair (or bootstrap) path.

---

## Debug logging

The companion app uses `OPENCLAW_LINUX_LOG` to control logging verbosity.

If unset or invalid, the app defaults to `INFO`.

Example:

```bash
OPENCLAW_LINUX_LOG=debug ./build/openclaw-linux
```

Supported levels:
- `trace`
- `debug`
- `info`
- `warn`
- `error`

### Suggested usage

```bash
OPENCLAW_LINUX_LOG=trace ./build/openclaw-linux
```

This is especially useful when validating:
- startup before onboarding
- live transition during `openclaw onboard --install-daemon`
- gateway service transitions
- tray/helper lifecycle
- diagnostics refresh behavior

---

## Quick command summary

### Build OpenClaw

```bash
cd ~/openclaw
corepack install
pnpm install
pnpm ui:build
pnpm build
```

### Build/test Linux app

```bash
cd ~/openclaw/apps/linux
meson setup build
meson test -C build
meson compile -C build
```

### Run Linux app

```bash
cd ~/openclaw/apps/linux
./build/openclaw-linux
```

### Onboard OpenClaw and install user gateway service

```bash
cd ~/openclaw
node openclaw.mjs onboard --install-daemon
```

---

## Current limitations / next documentation targets

Not documented here yet:
- deeper first-run onboarding UX details
- macOS companion parity comparisons
- broader diagnostics polish
- deeper in-app recovery guidance

Those are valid next steps, but they are intentionally outside this README for now. The current document is meant to lock down the current Linux lifecycle around `openclaw onboard --install-daemon` first.
