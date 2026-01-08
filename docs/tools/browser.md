---
summary: "Integrated browser control server + action commands"
read_when:
  - Adding agent-controlled browser automation
  - Debugging why clawd is interfering with your own Chrome
  - Implementing browser settings + lifecycle in the macOS app
---

# Browser (clawd-managed)

Clawdbot can run a **dedicated Chrome/Chromium profile** that the agent controls.
It is isolated from your personal browser and is managed through a small local
control server.

## What you get

- A separate browser profile named **clawd** (orange accent by default).
- Deterministic tab control (list/open/focus/close).
- Agent actions (click/type/drag/select), snapshots, screenshots, PDFs.
- Optional multi-profile support (`clawd`, `work`, `remote`, ...).

This browser is **not** your daily driver. It is a safe, isolated surface for
agent automation and verification.

## Quick start

```bash
clawdbot browser status
clawdbot browser start
clawdbot browser open https://example.com
clawdbot browser snapshot
```

If you get “Browser disabled”, enable it in config (see below) and restart the
Gateway.

## Configuration

Browser settings live in `~/.clawdbot/clawdbot.json`.

```json5
{
  browser: {
    enabled: true,                    // default: true
    controlUrl: "http://127.0.0.1:18791",
    cdpUrl: "http://127.0.0.1:18792", // defaults to controlUrl + 1
    defaultProfile: "clawd",
    color: "#FF4500",
    headless: false,
    noSandbox: false,
    attachOnly: false,
    executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    profiles: {
      clawd: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" }
    }
  }
}
```

Notes:
- `controlUrl` defaults to `http://127.0.0.1:18791`.
- If you override the Gateway port (`gateway.port` or `CLAWDBOT_GATEWAY_PORT`),
  the default browser ports shift to stay in the same “family” (control = gateway + 2).
- `cdpUrl` defaults to `controlUrl + 1` when unset.
- `attachOnly: true` means “never launch Chrome; only attach if it is already running.”

## Local vs remote control

- **Local control (default):** `controlUrl` is loopback (`127.0.0.1`/`localhost`).
  The Gateway starts the control server and can launch Chrome.
- **Remote control:** `controlUrl` is non-loopback. The Gateway **does not** start
  a local server; it assumes you are pointing at an existing server elsewhere.
- **Remote CDP:** set `browser.profiles.<name>.cdpUrl` (or `browser.cdpUrl`) to
  attach to a remote Chrome. In this case, Clawdbot will not launch a local browser.

## Profiles (multi-browser)

Clawdbot supports multiple named profiles. Each profile has its own:
- user data directory
- CDP port (local) or CDP URL (remote)
- accent color

Defaults:
- The `clawd` profile is auto-created if missing.
- Local CDP ports allocate from **18800–18899** by default.
- Deleting a profile moves its local data directory to Trash.

All control endpoints accept `?profile=<name>`; the CLI uses `--browser-profile`.

## Isolation guarantees

- **Dedicated user data dir**: never touches your personal Chrome profile.
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.
- **Deterministic tab control**: target tabs by `targetId`, not “last tab”.

## Browser selection

When launching locally, Clawdbot picks the first available:
1. Chrome Canary
2. Chromium
3. Chrome

You can override with `browser.executablePath`.

Platforms:
- macOS: checks `/Applications` and `~/Applications`.
- Linux: looks for `google-chrome`, `chromium`, etc.
- Windows: checks common install locations.

## Control API (optional)

If you want to integrate directly, the browser control server exposes a small
HTTP API:

- Status/start/stop: `GET /`, `POST /start`, `POST /stop`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Actions: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Debugging: `GET /console`, `POST /pdf`

All endpoints accept `?profile=<name>`.

### Playwright requirement

Some features (navigate/act/ai snapshot, element screenshots, PDF) require
Playwright. In embedded gateway builds, Playwright may be unavailable; those
endpoints return a clear 501 error. ARIA snapshots and basic screenshots still work.

## CLI quick reference

All commands accept `--browser-profile <name>` to target a specific profile.

Basics:
- `clawdbot browser status`
- `clawdbot browser start`
- `clawdbot browser stop`
- `clawdbot browser tabs`
- `clawdbot browser open https://example.com`
- `clawdbot browser focus abcd1234`
- `clawdbot browser close abcd1234`

Inspection:
- `clawdbot browser screenshot`
- `clawdbot browser screenshot --full-page`
- `clawdbot browser screenshot --ref 12`
- `clawdbot browser snapshot`
- `clawdbot browser snapshot --format aria --limit 200`
- `clawdbot browser console --level error`
- `clawdbot browser pdf`

Actions:
- `clawdbot browser navigate https://example.com`
- `clawdbot browser resize 1280 720`
- `clawdbot browser click 12 --double`
- `clawdbot browser type 23 "hello" --submit`
- `clawdbot browser press Enter`
- `clawdbot browser hover 44`
- `clawdbot browser drag 10 11`
- `clawdbot browser select 9 OptionA OptionB`
- `clawdbot browser upload /tmp/file.pdf`
- `clawdbot browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'`
- `clawdbot browser dialog --accept`
- `clawdbot browser wait --text "Done"`
- `clawdbot browser evaluate --fn '(el) => el.textContent' --ref 7`

Notes:
- `upload` and `dialog` are **arming** calls; run them before the click/press
  that triggers the chooser/dialog.
- `upload` can also set file inputs directly via `--input-ref` or `--element`.
- `snapshot` defaults to `ai` when available; use `--format aria` for the
  accessibility tree.
- `click`/`type` require a `ref` from `snapshot` (CSS selectors are intentionally
  not supported for actions).

## Security & privacy

- The clawd browser profile may contain logged-in sessions; treat it as sensitive.
- Keep control URLs loopback-only unless you intentionally expose the server.
- Remote CDP endpoints are powerful; tunnel and protect them.

## Troubleshooting

For Linux-specific issues (especially snap Chromium), see
[Browser troubleshooting](/tools/browser-linux-troubleshooting).
