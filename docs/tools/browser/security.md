---
summary: "Loopback auth for the browser control API and remote CDP credential handling"
title: "Browser security"
read_when:
  - You are reviewing how the browser control API authenticates
  - You are handling remote CDP tokens
---

Key ideas:

- Browser control is loopback-only; access flows through the Gateway's auth or node pairing.
- The standalone loopback browser HTTP API uses **shared-secret auth only**:
  gateway token bearer auth, `x-openclaw-password`, or HTTP Basic auth with the
  configured gateway password.
- Tailscale Serve identity headers and `gateway.auth.mode: "trusted-proxy"` do
  **not** authenticate this standalone loopback browser API.
- If browser control is enabled and no shared-secret auth is configured, OpenClaw
  auto-generates and persists a browser-control credential at startup:
  a token when `gateway.auth.mode` is `none`, or a password when it is
  `trusted-proxy` (persisted through `gateway.auth.password` so out-of-process
  loopback clients can resolve it). Auto-generation is skipped when an explicit
  string credential is already configured for that mode, or when
  `gateway.auth.mode` is `password`.
- Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or
  `OPENCLAW_GATEWAY_PASSWORD` explicitly if you want a stable secret you control
  instead of the generated one.

Remote CDP tips:

- Prefer encrypted endpoints (HTTPS or WSS) and short-lived tokens where possible.
- Avoid embedding long-lived tokens directly in config files.
- Keep the Gateway and any node hosts on a private network (Tailscale); avoid public exposure.
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.
