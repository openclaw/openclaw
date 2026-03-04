---
name: agent-browser
description: "自动操作浏览器。Use the built-in browser tool to open pages, click, type, take snapshots, and automate web tasks. Use when: (1) user asks to open a URL or check a webpage, (2) form filling or UI automation, (3) screenshots or PDF export, (4) multi-step web flows. NOT for: API calls (use bash/curl), reading local files, or when a simple web_fetch is enough."
metadata:
  {
    "openclaw": { "emoji": "🌐", "requires": {} },
  }
---

# Agent Browser (自动操作浏览器)

Use OpenClaw’s **browser** tool to control a dedicated browser profile: open tabs, click, type, snapshot, and run automation.

## When to use

- Open a URL and read or interact with the page
- Fill forms, click buttons, take screenshots
- Multi-step web flows (login, navigate, extract)
- Export page as PDF or capture a snapshot

## When NOT to use

- Simple HTTP/API calls → use `web_fetch` or `bash` with curl
- Reading local files → use file tools
- When only page content is needed and no interaction → consider `web_fetch` first

## Tool: browser

The agent has a `browser` tool. Typical actions:

- **Navigate:** open a URL, go back/forward
- **Interact:** click (selector or coordinates), type text, select options
- **Capture:** snapshot (DOM/text), screenshot, PDF
- **Tabs:** list, open, focus, close

Use the default profile (`openclaw` or `chrome` per config). For headless or remote browser, set `browser.profiles.<name>.cdpUrl` in config.

## CLI (for humans)

```bash
openclaw browser --browser-profile openclaw status
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Config

In `~/.openclaw/openclaw.json`: `browser.enabled: true`, `browser.defaultProfile`, and optional `browser.profiles`. See [Browser](/tools/browser).
