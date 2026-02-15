# macOS Launcher

A simple macOS app that starts the OpenClaw gateway and opens the Control UI.

## What it does

1. Checks if gateway is already running
2. If not, starts `openclaw gateway run` in the background
3. Opens http://127.0.0.1:18789/ in your browser
4. Shows a notification

## Build

```bash
./build.sh
```

This creates `~/Desktop/OpenClaw.app`.

To install to Applications:

```bash
./build.sh /Applications/OpenClaw.app
```

## Requirements

- macOS
- `openclaw` installed globally, or available via `npx`

## First run

macOS Gatekeeper may block the app. Right-click → "Open" to bypass.
