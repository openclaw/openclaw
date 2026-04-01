# OpenClaw Desktop

`apps/desktop/` is a small Tauri v2 desktop companion for OpenClaw focused on a
first Linux/Windows PR.

## MVP scope

- System tray with:
  - `Open Dashboard`
  - `Gateway Status: Connected/Disconnected`
  - `Restart Gateway`
  - `Quit`
- Main window that embeds the existing Gateway Control UI
- Gateway health polling via `http://<host>:<port>/health`
- Hide-to-tray behavior when the main window is closed
- Local config discovery from `~/.openclaw/openclaw.json`

## How it works

- The Rust backend reads `gateway.port`, `gateway.bind`, `gateway.customBindHost`,
  `gateway.tls.enabled`, and `gateway.auth.token` from `~/.openclaw/openclaw.json`.
- For this MVP, the local companion prefers loopback and uses `gateway.customBindHost`
  when `gateway.bind` is set to `custom`.
- The embedded dashboard URL is derived from the gateway websocket URL:
  - `ws://127.0.0.1:18789` becomes `http://127.0.0.1:18789/`
  - `wss://...` becomes `https://...`
- If `gateway.auth.token` is present, the app passes it to the dashboard via URL fragment
  (`#token=...`) to match the existing Control UI behavior.

## Dev setup

1. Install workspace dependencies at the repo root:

```bash
pnpm install
```

2. Install Tauri prerequisites:

- Windows: Rust toolchain + WebView2 runtime
- Linux: Rust toolchain + the WebKitGTK / GTK packages required by Tauri

3. Start the desktop app from the repo root:

```bash
pnpm desktop:dev
```

4. Build it:

```bash
pnpm desktop:build
```

For this MVP, `desktop:build` produces a release binary without installer bundling yet.

## Notes

- `Restart Gateway` runs `openclaw gateway restart`, so the CLI must already be installed
  and available on `PATH`.
- Password-based gateway auth is not auto-injected into the embedded dashboard URL.
  Token-based auth is the smoother path for this MVP.
- The tray icon is generated in Rust and switches between green and red based on the
  most recent health probe result.
- Tauri bundling is intentionally disabled in this first PR so Linux/Windows packaging
  work can land separately from the core tray + dashboard experience.
