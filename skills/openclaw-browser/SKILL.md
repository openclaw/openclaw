---
name: openclaw-browser
description: Launch and manage the OpenClaw managed Chromium browser in GUI mode so the user can watch browser automation in real-time. Use when the user asks to open the OpenClaw browser, set up browser GUI mode, create browser shortcuts, or wants to see what the agent is doing in the browser. Also triggers on "브라우저 열어줘", "브라우저 보여줘", "웹 자동화 보여줘", "OpenClaw Browser", "GUI 브라우저".
---

# OpenClaw Browser (GUI Mode)

OpenClaw manages its own Chromium instance via CDP. By default it runs headless. GUI mode makes it visible.

## Quick Setup

1. Set `browser.headless: false` in `~/.openclaw/openclaw.json`
2. (Optional) Run `scripts/create-shortcut.ps1` for a desktop shortcut

## Usage

```
# Start and open a page (preferred)
browser action=start profile=openclaw
browser action=open url=https://example.com profile=openclaw

# Stop
browser action=stop profile=openclaw
```

With `headless: false`, the Chrome window appears on the user's monitor automatically.

## Key Facts

| Item       | Value                                    |
| ---------- | ---------------------------------------- |
| CDP Port   | 18800                                    |
| Profile    | `~/.openclaw/browser/openclaw/user-data` |
| Config key | `browser.headless`                       |

## Rules

- **One instance at a time** — agent start and desktop shortcut share CDP port 18800
- **Separate login sessions** — this browser has its own profile, independent from user's Chrome
- **No Relay needed** — this is NOT the Chrome Extension Relay; it's a standalone managed instance

## References

- `references/setup-details.md` — detailed config, shortcut args, Method A/B/C usage patterns
