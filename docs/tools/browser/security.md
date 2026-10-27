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
- If an HTTP listener (the standalone browser server or a sandbox browser bridge)
  starts and no shared-secret auth is configured, OpenClaw generates a
  browser-control credential for it:
  - When `gateway.auth.mode` is `none`, it generates a token and persists it as
    `gateway.auth.token`.
  - When `gateway.auth.mode` is `trusted-proxy`, it generates a password that
    stays in the Gateway process and is never written to config. Under
    trusted-proxy auth, `gateway.auth.password` is also a local Gateway login,
    and changing it restarts the Gateway.

  Out-of-process clients of the standalone loopback API under trusted-proxy
  therefore need an explicit `gateway.auth.password`.

  Auto-generation is skipped when an explicit string credential is already
  configured for that mode, or when `gateway.auth.mode` is `password`.

- The Gateway's in-process browser service has no HTTP listener. Starting it on
  first browser use never generates a credential or writes config.
- Configure `gateway.auth.token`, `gateway.auth.password`, `OPENCLAW_GATEWAY_TOKEN`, or
  `OPENCLAW_GATEWAY_PASSWORD` explicitly if you want a stable secret you control
  instead of the generated one.

Remote CDP tips:

- Prefer encrypted endpoints (HTTPS or WSS) and short-lived tokens where possible.
- Avoid embedding long-lived tokens directly in config files.
- Keep the Gateway and any node hosts on a private network (Tailscale); avoid public exposure.
- Treat remote CDP URLs/tokens as secrets; prefer env vars or a secrets manager.

## Local preview access

When `browser.ssrfPolicy` is absent, agents with unrestricted execution on the
Gateway host can navigate to `localhost`, `127.0.0.1`, and `::1` on any port in
OpenClaw's own live, managed local Chrome. This includes unrelated services bound
to loopback, consistent with that agent's existing host execution access.
For Gateway-managed execution, `tools.gatewayPolicy` must also permit `exec`;
independently authorized native harness execution keeps its own authority.

Any explicit `browser.ssrfPolicy`, including `{}`, disables this automatic
exception. Restricted or sandboxed agents, remote browser targets, externally
managed profiles, and browsers reached through a tunnel do not qualify. A live
OpenClaw-owned process is required; a loopback CDP address alone is insufficient.

The exception belongs to one tool invocation. OpenClaw checks its authority again
before navigation and before continuing each intercepted redirect hop, including
out-of-process iframe documents. It does not widen stored policy or grant private
network access to other tools. Playwright is required for the exception; without
it, the existing browser policy applies.

A runtime config reload retires the current automatic grant. A fresh assistant
turn prepares it again; ordinary policy-controlled browser access is unaffected.
