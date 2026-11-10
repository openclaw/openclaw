---
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control on Linux"
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: "Browser troubleshooting"
---

## Problem: Failed to start Chrome CDP on port 18800

```json
{ "error": "Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"." }
```

### Root cause

On Ubuntu and most Linux distros, `apt install chromium` installs a snap
wrapper, not a real browser:

```text
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors
the browser process.

Other common Linux launch failures:

- `GPU process isn't usable. Goodbye.`: Chromium exhausted its GPU fallback
  options. Check the preceding Chrome stderr for the first GPU-process failure.
  Inherited jemalloc `LD_PRELOAD` with `MALLOC_CONF=background_thread:true`
  can make the zygote multi-threaded before fork, causing GPU subprocess launch
  failures (`error_code=1002`). Managed Chrome launches strip `MALLOC_CONF` and
  jemalloc entries from `LD_PRELOAD`, preserving other preload libraries and the
  Gateway's own allocator settings. Wrappers that re-add these variables must
  remove them before executing Chrome.
  Managed headless launches already use `--headless=new --disable-gpu`; try
  removing custom GPU flags from `browser.extraArgs` and verify the configured
  browser executable works on the host. Adding `--enable-unsafe-swiftshader`
  lowers WebGL security guarantees and is not a general fix for this fatal error.
- `The profile appears to be in use by another Chromium process`: stale
  `Singleton*` lock files in the managed profile directory. OpenClaw removes
  these locks and retries once when the lock points at a dead process on the
  current host. Locks naming another hostname are preserved until you verify
  that the profile is no longer in use, including after a machine rename.
- `Missing X server or $DISPLAY`: a visible browser was explicitly requested
  on a host without a desktop session. Local managed profiles use headless
  mode by default, including when a desktop session is available.
  If you set `OPENCLAW_BROWSER_HEADLESS=0`, `browser.headless: false`, or
  `browser.profiles.<name>.headless: false`, remove that headed override, set
  `OPENCLAW_BROWSER_HEADLESS=1`, start `Xvfb`, run
  `openclaw browser start --headless` for a one-shot managed launch, or run
  OpenClaw in a real desktop session.

### Solution 1: install Google Chrome (recommended)

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Update `~/.openclaw/openclaw.json`:

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Solution 2: use snap Chromium in attach-only mode

If you must keep snap Chromium, configure OpenClaw to attach to a
manually-started browser instead of launching it:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

Start Chromium manually:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

Optionally auto-start it with a systemd user service:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now openclaw-browser.service
```

### Missing shared libraries

`error while loading shared libraries`: the browser binary exists, but the
host is missing a required runtime library. `openclaw browser doctor` runs
the local managed executable with `--version` and reports the loader error
as a failed **Chromium executable** check. Install the named library through
your distribution's package manager, or use a browser package that includes
the required dependencies. Downloading Playwright's Chromium alone does not
install system libraries. The probe does not start a browser or touch its
profile; ordinary status checks remain passive.

### Verify the browser works

OpenClaw logs a managed browser as started only after HTTP discovery and a CDP
command succeed. A child that exits during startup returns its exit code or
signal and captured stderr to the browser tool, and logs the failure. Abnormal
exits after readiness are also logged with bounded stderr. After correcting the
executable or launch arguments, retry; if the browser remains unavailable, use
another configured profile or an alternative tool.

These calls go to the OpenClaw browser control service, not to the Chrome CDP
port used above. Its port is derived from `gateway.port` (default `18791` =
gateway port + 2), so adjust the number if you moved the Gateway port. `jq` only
pretty-prints the response; drop the pipe if you do not have it installed.

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config reference

| Option                      | Description                                                          | Default                                                            |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `browser.enabled`           | Enable browser control                                               | `true`                                                             |
| `browser.executablePath`    | Path to a Chromium-based browser binary (Chrome/Brave/Edge/Chromium) | auto-detected (prefers the OS default browser when Chromium-based) |
| `browser.headless`          | Run without GUI                                                      | `true`                                                             |
| `OPENCLAW_BROWSER_HEADLESS` | Per-process override for local managed browser headless mode         | unset                                                              |
| `browser.noSandbox`         | Add `--no-sandbox` flag (needed for some Linux setups)               | `false`                                                            |
| `browser.attachOnly`        | Do not launch a browser; only attach to an existing one              | `false`                                                            |

On Raspberry Pi, older VPS hosts, or slow storage, use a manually launched
browser with `attachOnly` when Chrome needs more time to expose its CDP HTTP
endpoint or become ready than the managed-browser deadline permits.

## Problem: No Chrome tabs found for profile="user"

You are using the `user` (`existing-session` / Chrome MCP) profile and no
tabs are open to attach to.

Fix options:

1. Use the managed browser instead:
   `openclaw browser --browser-profile openclaw start` (or set
   `browser.defaultProfile: "openclaw"`).
2. Keep local Chrome running with at least one open tab, then retry with
   `--browser-profile user`.

Notes:

- `user` is host-only. On Linux servers, containers, or remote hosts, prefer
  CDP profiles instead.
- `user` and other `existing-session` profiles share the current Chrome MCP
  limits: ref-driven actions only, one file per upload, no dialog `timeoutMs`
  overrides, no `wait --load networkidle`, and no `responsebody`, PDF export,
  download interception, or batch actions.
- Local `openclaw`-driver profiles get a `cdpPort` allocated when OpenClaw
  creates them; a profile you declare by hand must set `cdpPort` itself, or
  `cdpUrl` for remote CDP.
- Remote CDP profiles accept `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) for `/json/version` discovery, or WS(S) when your browser
  service gives you a direct DevTools socket URL.

## Related

- [Browser](/tools/browser)
- [Browser login](/tools/browser-login)
- [Browser WSL2 troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)
