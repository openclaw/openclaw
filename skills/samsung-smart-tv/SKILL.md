---
name: samsung-smart-tv
description: Control Samsung TVs via SmartThings (OAuth app + device control).
homepage: https://developer.smartthings.com/docs
metadata: {"clawdbot":{"emoji":"📺","requires":{"bins":["python3","npx"]},"install":[{"id":"python-brew","kind":"brew","formula":"python","bins":["python3"],"label":"Install Python (brew)"},{"id":"node-brew","kind":"brew","formula":"node","bins":["node","npx"],"label":"Install Node.js (brew)"}]}}
---

# Samsung Smart TV (SmartThings)

This skill provisions a SmartThings OAuth app and stores the credentials for Clawdbot.

Setup (one-time)
- `python3 {baseDir}/scripts/setup_smartthings.py`
- Re-run to refresh credentials: `python3 {baseDir}/scripts/setup_smartthings.py --force`

What it does
- Creates an OAuth-In SmartApp with a fixed display name: `smartthings-clawdbot`
- Uses scopes: `r:devices:*`, `w:devices:*`
- Redirect URI: `http://127.0.0.1:8789/callback`
- Writes `SMARTTHINGS_APP_ID`, `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET` to `~/.clawdbot/.env` (or `CLAWDBOT_STATE_DIR/.env`)

Device setup
- Find your TV device id: `smartthings devices --json`
- Store it as `SMARTTHINGS_DEVICE_ID` in the same `.env`

Common commands
- List devices: `smartthings devices --json`
- List capabilities: `smartthings devices:capabilities <DEVICE_ID> --json`
- Device status: `smartthings devices:status <DEVICE_ID> --json`
- Switch on/off: `smartthings devices:commands <DEVICE_ID> switch on`
- Set volume: `smartthings devices:commands <DEVICE_ID> audioVolume setVolume 15`
- Mute/unmute: `smartthings devices:commands <DEVICE_ID> audioMute mute`

App launch (Netflix/Prime Video)
- App launch is device-specific; look for `applicationLauncher` or `samsungtv` in capabilities.
- Discover app IDs in `devices:status` under `supportedApps` or `installedApps`.
- Launch: `smartthings devices:commands <DEVICE_ID> applicationLauncher launchApp appId=<APP_ID>`
- Example IDs are not universal; use the IDs listed for your TV (Netflix / Prime should show up if installed).

Notes
- If the SmartThings CLI is not logged in, it will open a browser to authenticate.
- Re-running the setup is safe; it updates the env entries in place.
