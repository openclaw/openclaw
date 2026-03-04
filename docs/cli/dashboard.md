---
summary: "CLI reference for `openclaw dashboard` (open the Control UI)"
read_when:
  - You want to open the Control UI with your current token
  - You want to print the URL without launching a browser
title: "dashboard"
---

# `openclaw dashboard`

Open the Control UI using your current auth.

```bash
openclaw dashboard
openclaw dashboard --no-open
openclaw dashboard dev
openclaw dashboard dev --no-open
openclaw dashboard dev --ui-port 18888
```

## Dev mode (HMR)

`openclaw dashboard dev` opens a Vite dev URL with `gatewayUrl` (and token when
present), then starts the UI dev server with hot reload.

Notes:

- This mode requires a source checkout (repo root with `ui/` + `scripts/ui.js`).
- Keep the command running while you are developing the UI.
- Default dev port is `gateway.port + 1` (for example `18790` when Gateway is `18789`).
- Override with `--ui-port <port>` or `OPENCLAW_CONTROL_UI_DEV_PORT`.
