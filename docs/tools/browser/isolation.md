---
summary: "What the managed profile isolates, which browser binary is picked, and where the control API reference lives"
title: "Isolation and browser selection"
read_when:
  - You need to know what the managed browser keeps separate from your own
  - You want the local browser detection order per platform
  - You are looking for the HTTP control API reference
---

## Isolation guarantees

- **Dedicated user data dir**: never touches your personal browser profile.
- **Dedicated ports**: avoids `9222` to prevent collisions with dev workflows.
- **Deterministic tab control**: `tabs` returns `suggestedTargetId` first, then
  stable `tabId` handles such as `t1`, optional labels, and the raw `targetId`.
  Agents should reuse `suggestedTargetId`; raw ids remain available for
  debugging and compatibility.

## Browser selection

When launching locally, OpenClaw picks the first available:

1. Chrome
2. Brave
3. Edge
4. Chromium
5. Chrome Canary

You can override with `browser.executablePath`.

Platforms:

- macOS: checks `/Applications` and `~/Applications`.
- Linux: checks common Chrome/Brave/Edge/Chromium locations under `/usr/bin`,
  `/snap/bin`, `/opt/google`, `/opt/brave.com`, `/usr/lib/chromium`, and
  `/usr/lib/chromium-browser`, plus Playwright-managed Chromium under
  `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`.
- Windows: checks common install locations.

## Control API (optional)

For scripting and debugging, the Gateway exposes a small **loopback-only HTTP
control API** plus a matching `openclaw browser` CLI (snapshots, refs, wait
power-ups, JSON output, debug workflows). See
[Browser control API](/tools/browser-control) for the full reference.
