---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Fix Chrome/Brave/Edge/Chromium CDP startup issues for OpenClaw browser control on Linux"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "Browser control fails on Linux, especially with snap Chromium"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Browser Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Browser Troubleshooting (Linux)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Problem: "Failed to start Chrome CDP on port 18800"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw's browser control server fails to launch Chrome/Brave/Edge/Chromium with the error:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Root Cause（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On Ubuntu (and many Linux distros), the default Chromium installation is a **snap package**. Snap's AppArmor confinement interferes with how OpenClaw spawns and monitors the browser process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `apt install chromium` command installs a stub package that redirects to snap:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note, selecting 'chromium-browser' instead of 'chromium'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
chromium-browser is already the newest version (2:1snap1-0ubuntu2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is NOT a real browser — it's just a wrapper.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Solution 1: Install Google Chrome (Recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install the official Google Chrome `.deb` package, which is not sandboxed by snap:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo dpkg -i google-chrome-stable_current_amd64.deb（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt --fix-broken install -y  # if there are dependency errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then update your OpenClaw config (`~/.openclaw/openclaw.json`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "browser": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "executablePath": "/usr/bin/google-chrome-stable",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "headless": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "noSandbox": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Solution 2: Use Snap Chromium with Attach-Only Mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you must use snap Chromium, configure OpenClaw to attach to a manually-started browser:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Update config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "browser": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "enabled": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "attachOnly": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "headless": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "noSandbox": true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Start Chromium manually:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
chromium-browser --headless --no-sandbox --disable-gpu \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --remote-debugging-port=18800 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  about:blank &（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Optionally create a systemd user service to auto-start Chrome:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ini（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ~/.config/systemd/user/openclaw-browser.service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Unit]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Description=OpenClaw Browser (Chrome CDP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After=network.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Service]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restart=on-failure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
RestartSec=5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Install]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WantedBy=default.target（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable with: `systemctl --user enable --now openclaw-browser.service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Verifying the Browser Works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Check status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Test browsing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s -X POST http://127.0.0.1:18791/start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -s http://127.0.0.1:18791/tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Config Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Option                   | Description                                                          | Default                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.enabled`        | Enable browser control                                               | `true`                                                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.executablePath` | Path to a Chromium-based browser binary (Chrome/Brave/Edge/Chromium) | auto-detected (prefers default browser when Chromium-based) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.headless`       | Run without GUI                                                      | `false`                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.noSandbox`      | Add `--no-sandbox` flag (needed for some Linux setups)               | `false`                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.attachOnly`     | Don't launch browser, only attach to existing                        | `false`                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `browser.cdpPort`        | Chrome DevTools Protocol port                                        | `18800`                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Problem: "Chrome extension relay is running, but no tab is connected"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You’re using the `chrome` profile (extension relay). It expects the OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
browser extension to be attached to a live tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Use the managed browser:** `openclaw browser start --browser-profile openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   (or set `browser.defaultProfile: "openclaw"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Use the extension relay:** install the extension, open a tab, and click the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   OpenClaw extension icon to attach it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The `chrome` profile uses your **system default Chromium browser** when possible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Local `openclaw` profiles auto-assign `cdpPort`/`cdpUrl`; only set those for remote CDP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
