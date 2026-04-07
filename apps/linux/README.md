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
- diagnostics window with systemd + gateway runtime state

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
  glib-networking
```

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
