---
name: openclaw-browser
description: Launch and manage the OpenClaw managed Chromium browser in GUI mode so the user can watch browser automation in real-time. Use when the user asks to open the OpenClaw browser, set up browser GUI mode, create browser shortcuts, or wants to see what the agent is doing in the browser. Also triggers on "브라우저 열어줘", "브라우저 보여줘", "웹 자동화 보여줘", "OpenClaw Browser", "GUI 브라우저".
---

# OpenClaw Browser (GUI Mode)

OpenClaw manages its own Chromium instance via CDP. By default it runs headless (invisible). GUI mode makes it visible on the user's monitor.

## Setup

### 1. Enable GUI mode in config

Set `browser.headless: false` in `~/.openclaw/openclaw.json`:

```json
{
  "browser": {
    "headless": false
  }
}
```

### 2. Desktop shortcut (optional)

Run `scripts/create-shortcut.ps1` to create a desktop shortcut that launches Chrome with the OpenClaw CDP profile:

```powershell
powershell -ExecutionPolicy Bypass -File <skill-dir>/scripts/create-shortcut.ps1
```

## Usage

### Method A: Agent starts browser (preferred)

Use the `browser` tool:

```
browser action=start profile=openclaw
browser action=open url=https://example.com profile=openclaw
```

With `headless: false`, the Chrome window appears on the user's monitor automatically.

### Method B: User starts via shortcut

User opens "OpenClaw Browser" shortcut → agent attaches via CDP on port 18800:

```
browser action=status profile=openclaw   # verify cdpReady=true
browser action=open url=https://example.com profile=openclaw
```

### Method C: Stop browser

```
browser action=stop profile=openclaw
```

## Key Details

| Item | Value |
|---|---|
| CDP Port | 18800 |
| Profile data | `~/.openclaw/browser/openclaw/user-data` |
| Config key | `browser.headless` |
| Executable | System Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) |

## Rules

- **One instance at a time.** Agent `browser start` and desktop shortcut use the same CDP port (18800). Don't run both simultaneously.
- **Separate login sessions.** This browser has its own profile — site logins are independent from the user's main Chrome.
- **No Relay needed.** This is NOT the Chrome Extension Relay. It's a standalone managed instance.
- **Shortcut args:** `--remote-debugging-port=18800 --user-data-dir=<profile-path> --no-first-run --no-default-browser-check`
