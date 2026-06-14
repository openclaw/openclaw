# OpenClaw Linux (GTK)

A native Linux desktop companion for OpenClaw, built with **Rust + GTK4 + libadwaita**.

> **Status**: early, usable, needs polish. Tracks [#75](https://github.com/openclaw/openclaw/issues/75)
> ("Linux/Windows Clawdbot Apps"). This is a Rust alternative alongside tiagonix's
> C/GTK4 effort at `apps/linux/` — same destination, different tradeoffs.

## What it does

Connects to your local OpenClaw gateway over WebSocket and surfaces agents, sessions,
models, channels, skills, cron jobs, and usage data through a native libadwaita UI.

Current views:

- **Chat** — live send/receive with Markdown-rendered assistant bubbles, history
  load per session, model picker (per-session model override via `sessions.patch`),
  typing indicator, thinking/tool-call toggles
- **Agents** — master/detail panel with per-agent settings (name, workspace, avatar,
  model) and workspace files list
- **Overview / Channels / Sessions / Skills / Cron / Usage / Workflows / Logs /
  Instances** — read-only management surfaces, each backed by a gateway RPC
- **Config / Settings / Debug / Control Room / About** — diagnostics and inspection

## Build

Requires Rust 1.80+ and GTK4 + libadwaita development packages.

**Debian/Ubuntu:**

```bash
sudo apt install libgtk-4-dev libadwaita-1-dev libsoup-3.0-dev \
  libsourceview-5-dev build-essential pkg-config
```

**Fedora:**

```bash
sudo dnf install gtk4-devel libadwaita-devel libsoup3-devel \
  gtksourceview5-devel
```

**Arch:**

```bash
sudo pacman -S gtk4 libadwaita libsoup3 gtksourceview5 base-devel
```

Then:

```bash
cd apps/linux-gtk
cargo build --release
./target/release/openclaw-gtk
```

## Run

The app reads gateway config from `~/.openclaw/openclaw.json`, with env var overrides:

| Variable                       | Purpose                                                |
| ------------------------------ | ------------------------------------------------------ |
| `OPENCLAW_GATEWAY_URL`         | WebSocket URL (default `wss://127.0.0.1:9443`)         |
| `OPENCLAW_GATEWAY_TOKEN`       | Gateway auth token (from `gateway.auth.token`)         |
| `OPENCLAW_TLS_ACCEPT_INVALID=1`| Accept self-signed certs (local dev only)              |
| `GSK_RENDERER=cairo`           | Force Cairo renderer — recommended on X11/tiling WMs   |
| `RUST_LOG=openclaw_gtk=debug`  | Verbose tracing                                        |

Example:

```bash
OPENCLAW_TLS_ACCEPT_INVALID=1 \
OPENCLAW_GATEWAY_TOKEN="$(jq -r .gateway.auth.token ~/.openclaw/openclaw.json)" \
GSK_RENDERER=cairo \
./target/release/openclaw-gtk
```

## Layout

```
apps/linux-gtk/
├── Cargo.toml                      # workspace root
├── crates/
│   ├── gateway-client/             # async WebSocket + RPC client (no GTK deps)
│   │   ├── src/client.rs           #   tokio-based connect/reconnect loop
│   │   ├── src/protocol.rs         #   typed frames (connect, request, event)
│   │   ├── src/identity.rs         #   device identity (ed25519 signing)
│   │   └── src/config.rs           #   env > file > defaults resolution
│   └── app/                        # GTK4 UI
│       ├── src/app.rs              #   application entry + lifecycle
│       ├── src/window.rs           #   main window, sidebar, top bar
│       ├── src/bridge.rs           #   async-channel → GLib main-loop bridge
│       ├── src/state.rs            #   AppState (shared UI state)
│       ├── src/session_filter.rs   #   pure session-picker logic (tested)
│       ├── src/markdown.rs         #   Markdown → Pango markup
│       ├── src/views/              #   one file per tab
│       └── src/widgets/            #   reusable bubbles, placeholders, toasts
└── data/                           # .desktop, icons, appstream metainfo, style.css
```

## Known gaps / TODO

- **Security review needed** — device identity handling, TLS verification flow,
  token persistence all need a fresh pair of eyes before production use
- No packaging yet (Flatpak/deb/AppImage). Build-from-source only.
- Tool-call rendering in chat is basic (JSON args in collapsible blocks)
- No system tray on tiling WMs (StatusNotifierWatcher not registered) — falls
  back cleanly, no crash
- Editable fields in Agents view call `agents.update` but lack optimistic UI
  feedback on success/error
- Config editor view is read-only
- Polling timers (100ms for chat, 1s for connection status) could be replaced
  with event-driven updates when the gateway starts broadcasting those
- Message compose lacks attachment/file upload support
- No keyboard shortcuts beyond GTK defaults

## License

MIT, same as the rest of OpenClaw.
