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

## Local previews

With `browser.ssrfPolicy` unset, an unrestricted agent can preview HTTP(S) apps
at `localhost`, `127.0.0.1`, and `::1` in a local OpenClaw-managed browser. This
covers all ports, including unrelated local services. Eligibility requires
unrestricted local host execution without approval, no sandbox, and no workspace
restriction; enabling the Browser tool alone is insufficient.

Remote/node, attach-only, extension, and existing-session browsers do not receive
this default. Neither do direct browser HTTP/RPC requests or standalone browser
commands. Any explicit `browser.ssrfPolicy`, including `{}`, suppresses the
exception. Use that existing setting to keep loopback blocked or to define your
own narrow host exceptions. Other private networks and other tools are unchanged.

Automatic previews require a live browser process launched and verified by the current
OpenClaw control service. A reachable external browser, loopback CDP tunnel, or browser
left running across a control-service restart does not qualify. Stop that browser
yourself and let OpenClaw launch the managed profile again, or configure an explicit
`browser.ssrfPolicy.allowedHostnames` policy. Automatic previews use Playwright-backed
navigation so invocation and process ownership are rechecked before navigation dispatch.

The default changes at the next run after upgrading; no config migration or
persistent allowlist is written. Existing explicit policies retain their behavior.
See [SSRF policy](/tools/browser/configuration) for navigation checks
and [Security Policy](https://github.com/openclaw/openclaw/blob/main/SECURITY.md#local-browser-previews)
for the trust model.
