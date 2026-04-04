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

This README intentionally documents the **foundation-first** workflow:
- build OpenClaw
- build the Linux companion
- launch the Linux companion **before** `openclaw setup`
- launch again **before** `openclaw gateway install`
- then install the gateway service and validate the “ready” state

`openclaw onboard` is **not documented here yet**. That is intentional. The current focus is to verify and stabilize the base lifecycle from a clean machine to a ready local gateway.

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

## Run the Linux App before `openclaw setup`

From `apps/linux`:

```bash
./build/openclaw-linux
```

### What to expect

At this point, there is no initialized local OpenClaw environment yet.

That is expected.

The purpose of this step is to confirm the Linux companion launches cleanly **even when nothing has been set up yet**. This validates the base desktop/runtime behavior before introducing gateway state.

You should inspect the app and diagnostics at this stage to confirm the “no setup yet” behavior is understandable and stable.

---

## Initialize OpenClaw

In another terminal, from the repository root:

```bash
cd ~/openclaw
node openclaw.mjs setup
```

---

## Relaunch the Linux App before `openclaw gateway install`

Return to the Linux app terminal and launch it again:

```bash
cd ~/openclaw/apps/linux
./build/openclaw-linux
```

### What to expect

Now OpenClaw has been initialized, but the user gateway service is still not installed.

This is another intentional checkpoint. It lets you observe how the Linux companion behaves when OpenClaw exists locally, but the gateway service lifecycle has not yet been installed into `systemd --user`.

This stage is useful for validating diagnostics, expected warnings, and transition behavior.

---

## Install the OpenClaw user gateway service

From the repository root:

```bash
cd ~/openclaw
node openclaw.mjs gateway install
```

Optional direct inspection:

```bash
systemctl --user status openclaw-gateway.service
journalctl --user -fu openclaw-gateway.service
```

---

## Inspect the Linux App diagnostics

Launch the Linux app again if needed:

```bash
cd ~/openclaw/apps/linux
./build/openclaw-linux
```

At this point, the diagnostics/state should settle into a **ready** baseline for the local companion flow.

This is the current foundational checkpoint:
- OpenClaw built
- Linux app built and tested
- `openclaw setup` completed
- `openclaw gateway install` completed
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
- startup with no setup
- startup after setup but before gateway install
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

### Initialize OpenClaw

```bash
cd ~/openclaw
node openclaw.mjs setup
```

### Install user gateway service

```bash
cd ~/openclaw
node openclaw.mjs gateway install
```

---

## Current limitations / next documentation targets

Not documented here yet:
- `openclaw onboard`
- full first-run onboarding UX
- macOS companion parity comparisons
- broader diagnostics polish
- deeper in-app recovery guidance

Those are valid next steps, but they are intentionally outside this README for now. The current document is meant to lock down the foundational Linux lifecycle first.
