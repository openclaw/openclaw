---
summary: "Gateway dashboard (Control UI) access and auth"
read_when:
  - Changing dashboard authentication or exposure modes
---
# Dashboard (Control UI)

The Gateway dashboard is the browser Control UI served at `/` by default
(override with `gateway.controlUi.basePath`).

Quick open (local Gateway):
- http://127.0.0.1:18789/ (or http://localhost:18789/)

Key references:
- [`docs/control-ui.md`](https://docs.clawd.bot/web/control-ui) for usage and UI capabilities.
- [`docs/tailscale.md`](https://docs.clawd.bot/gateway/tailscale) for Serve/Funnel automation.
- [`docs/web.md`](https://docs.clawd.bot/web) for bind modes and security notes.

Authentication is enforced at the WebSocket handshake via `connect.params.auth`
(token or password). See `gateway.auth` in [`docs/configuration.md`](https://docs.clawd.bot/gateway/configuration).
