# OpenClaw Linux Companion App

A native GTK4 + Libadwaita companion app for managing the OpenClaw gateway on Ubuntu GNOME.

## Architecture

This application employs a multiprocess architecture to safely bridge GTK3 and GTK4:
1. `openclaw-linux`: The main application written in GTK4 + Libadwaita. It manages the D-Bus systemd integration, JSON health parsing, state machine, and diagnostics UI.
2. `openclaw-tray-helper`: A small background daemon written in GTK3 that strictly manages the Ayatana AppIndicator tray presence to avoid runtime `GType` collisions with GTK4.

**Note:** The `openclaw-tray-helper` is a private implementation detail, not a peer user-facing executable. It is installed into the system `libexec` directory and spawned transparently by the main application.

## Supported Targets
- **Ubuntu 24.04 GNOME**
- **Ubuntu 26.04 GNOME**

*Note: Debian is explicitly deferred from v1.*

## Build Dependencies
The app requires the following exact APT packages:
```bash
sudo apt update
sudo apt install gcc meson ninja-build pkg-config libgtk-4-dev libadwaita-1-dev libayatana-appindicator3-dev libjson-glib-dev
```

## Strategic Linux Context & Future Work

### Ubuntu 26.04 Node.js Path
On Ubuntu 26.04, OpenClaw development and testing can utilize the distro-native packages:
```bash
sudo apt install nodejs npm
```
*Note: This applies to the OpenClaw core/gateway environment. The companion app itself remains native C/GTK.*

### Node 22 Compatibility
Ubuntu 26.04 provides a native Node 22 path. This is strategically useful for Linux contributors and greatly simplifies native packaging. Therefore, continued Node 22 compatibility in the OpenClaw core is highly beneficial for the Linux ecosystem.

### Future Ayatana Migration (v2)
The current v1 architecture uses the GTK3 Ayatana AppIndicator path, which triggers deprecation warnings on Ubuntu 26.04. For v2, the companion app is expected to support two distinct build paths:
- Ubuntu 24.04: Using the current Ayatana path.
- Ubuntu 26.04: Using the newer, non-deprecated Ayatana direction/library.

### Future Systemd Journal Integration
A planned Linux-native enhancement will likely introduce `libsystemd-dev` to the companion app, providing stronger native diagnostics such as direct journal access and recent service log surfacing within the UI.

## Tray Support Requirements
The app uses Ayatana AppIndicator as a GTK-3+ compatibility bridge to surface the tray icon in GNOME.

- **Ubuntu 24.04:** Expects tray support through the `gnome-shell-extension-appindicator` package.
- **Ubuntu 26.04:** Runtime validation is required. Tested systems often expose `gnome-shell-ubuntu-extensions` rather than a standalone `gnome-shell-extension-appindicator` package. *(Note: GTK3 Ayatana backend deprecation warnings are known and accepted for v1 on 26.04).*

## Building
```bash
meson setup build
meson compile -C build
```

## Testing
```bash
meson test -C build
```

## Running (Development)
```bash
./build/openclaw-linux
```
