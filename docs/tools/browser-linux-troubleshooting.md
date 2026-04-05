---
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for Mullusi browser control on Linux"
read_when: "Browser control fails on Linux, especially with snap Chromium"
title: "Browser Troubleshooting"
---

# Browser Troubleshooting (Linux)

## Problem: "Failed to start Chrome CDP on port 18800"

Mullusi's browser control server fails to launch Chrome/Brave/Edge/Chromium with the error:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"mullusi\"."}
```

### Root Cause

On Ubuntu (and many Linux distros), the default Chromium installation is a **snap package**. Snap's AppArmor confinement interferes with how Mullusi spawns and monitors the browser process.

The `apt install chromium` command installs a stub package that redirects to snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

This is NOT a real browser - it's just a wrapper.

### Solution 1: Install Google Chrome (Recommended)

Install the official Google Chrome `.deb` package, which is not sandboxed by snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Then update your Mullusi config (`~/.mullusi/mullusi.json`):

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

### Solution 2: Use Snap Chromium with Attach-Only Mode

If you must use snap Chromium, configure Mullusi to attach to a manually-started browser:

1. Update config:

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

2. Start Chromium manually:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.mullusi/browser/mullusi/user-data \
  about:blank &
```

3. Optionally create a systemd user service to auto-start Chrome:

```ini
# ~/.config/systemd/user/mullusi-browser.service
[Unit]
Description=Mullusi Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.mullusi/browser/mullusi/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable with: `systemctl --user enable --now mullusi-browser.service`

### Verifying the Browser Works

Check status:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Test browsing:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Config Reference

| Option                   | Description                                                          | Default                                                     |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `browser.enabled`        | Enable browser control                                               | `true`                                                      |
| `browser.executablePath` | Path to a Chromium-based browser binary (Chrome/Brave/Edge/Chromium) | auto-detected (prefers default browser when Chromium-based) |
| `browser.headless`       | Run without GUI                                                      | `false`                                                     |
| `browser.noSandbox`      | Add `--no-sandbox` flag (needed for some Linux setups)               | `false`                                                     |
| `browser.attachOnly`     | Don't launch browser, only attach to existing                        | `false`                                                     |
| `browser.cdpPort`        | Chrome DevTools Protocol port                                        | `18800`                                                     |

### Problem: "No Chrome tabs found for profile=\"user\""

You're using an `existing-session` / Chrome MCP profile. Mullusi can see local Chrome,
but there are no open tabs available to attach to.

Fix options:

1. **Use the managed browser:** `mullusi browser start --browser-profile mullusi`
   (or set `browser.defaultProfile: "mullusi"`).
2. **Use Chrome MCP:** make sure local Chrome is running with at least one open tab, then retry with `--browser-profile user`.

Notes:

- `user` is host-only. For Linux servers, containers, or remote hosts, prefer CDP profiles.
- `user` / other `existing-session` profiles keep the current Chrome MCP limits:
  ref-driven actions, one-file upload hooks, no dialog timeout overrides, no
  `wait --load networkidle`, and no `responsebody`, PDF export, download
  interception, or batch actions.
- Local `mullusi` profiles auto-assign `cdpPort`/`cdpUrl`; only set those for remote CDP.
- Remote CDP profiles accept `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) for `/json/version` discovery, or WS(S) when your browser
  service gives you a direct DevTools socket URL.
