---
summary: "Legacy Chrome extension relay migration notes for current browser setup"
read_when:
  - You found older docs or config that mention a Chrome extension relay
  - You are migrating `browser.profiles.*.driver: \"extension\"`
  - You want to use your real signed-in Chrome tabs with current OpenClaw releases
title: "Chrome extension (legacy relay)"
---

# Chrome extension (legacy relay)

Older OpenClaw docs and configs described a **Chrome extension relay** flow for
controlling your existing Chrome tabs. That is **not** the current browser setup
for host-local browser attachment.

Current releases use the built-in `user` profile, or your own
`driver: "existing-session"` profile, to attach through **Chrome DevTools MCP**
instead of the removed extension driver path.

Use this page as a migration note if you still see references to:

- `browser.profiles.*.driver: "extension"`
- a built-in `chrome` profile for browser relay
- a dedicated relay server config such as `browser.relayBindHost`

## Current path

Use one of these instead:

- built-in `user` profile
- custom profile with `driver: "existing-session"`

Examples:

```bash
openclaw browser --browser-profile user tabs
openclaw browser create-profile --name chrome-live --driver existing-session
openclaw browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
```

```json5
{
  browser: {
    defaultProfile: "user",
    profiles: {
      user: {
        driver: "existing-session",
        attachOnly: true,
        color: "#00AA00",
      },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
        color: "#FB542B",
      },
    },
  },
}
```

## What changed

- `driver: "extension"` was replaced by `driver: "existing-session"`
- the old relay-specific config path is no longer the normal browser attach path
- the built-in attach profile is `user`, not `chrome`

OpenClaw doctor can normalize older browser configs:

- `browser.profiles.*.driver: "extension"` becomes `"existing-session"`
- `browser.relayBindHost` is removed

## When to use `user` vs `openclaw`

- Use `openclaw` when you want an isolated, OpenClaw-managed browser profile
- Use `user` when you need the browser tabs and login state already open in your
  local Chromium-based browser

The `user` / `existing-session` path is **host-local**. For Docker, remote
gateways, or hosted browsers, use a node host or a remote CDP profile instead.

## Related docs

- [Browser tool](/tools/browser)
- [browser CLI](/cli/browser)
- [Gateway doctor](/gateway/doctor)
- [Gateway configuration reference](/gateway/configuration-reference)
