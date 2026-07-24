---
summary: "Gateway rejects WebSocket upgrades from disallowed browser Origins before the HTTP 101, reusing the existing origin policy"
title: "WebSocket origin gate"
sidebarTitle: "WebSocket origin gate"
read_when:
  - Running the Gateway where a browser page could try to open a WebSocket upgrade (LAN, tailnet, reverse proxy, public)
  - Understanding why a browser from a disallowed Origin is rejected at the upgrade
  - Confirming there is no new config to enable for browser-origin enforcement
---

<Warning>
This gate enforces the **existing** `gateway.controlUi.allowedOrigins` policy at the WebSocket upgrade, before the connection opens. It does not add a new setting. Read [Trusted proxy auth](/gateway/trusted-proxy-auth) and the [Exposure runbook](/gateway/security/exposure-runbook) before exposing the Gateway.
</Warning>

## What it does

The Gateway already validates the browser `Origin` on the WebSocket path **after** the socket opens (in the post-handshake admission path). This gate runs the same `checkBrowserOrigin` check **before** the HTTP 101 upgrade, so a browser from a disallowed `Origin` is rejected (`403`) and never completes the connection.

- **No `Origin` header** (CLI, native apps) → accepted; these clients authenticate post-handshake as today.
- **`Origin` present** → checked against `checkBrowserOrigin` using `gateway.controlUi.allowedOrigins` and `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback`. On failure → `403` before the socket opens.
- A literal `null` opaque `Origin` is checked, not skipped — it cannot bypass the gate.

## Why pre-handshake

The upgrade phase is the only point where the `Origin` is available for enforcement before a live socket exists. Rejecting before the 101 means an unauthenticated browser never holds an open connection; the post-handshake admission path is unchanged and remains authoritative for role-scoped decisions.

## CSRF / cross-site note

This gate does **not** add a separate `Sec-Fetch-Site` check. A same-origin-only deployment therefore relies on `allowedOrigins` for cross-site WebSocket defense — which is exactly the contract the post-handshake admission path already enforces today. There is **no regression versus the prior behavior**: browser-origin enforcement was already `allowedOrigins`-based, this change only moves where that check runs (before the upgrade instead of after). Operators who need stricter cross-site controls can layer a reverse proxy that sets/validates `Origin` (see [Trusted proxy auth](/gateway/trusted-proxy-auth)).

## No new configuration

There are no new settings to enable. The gate reads the existing `gateway.controlUi.allowedOrigins` and `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback` values. If `allowedOrigins` is empty and the client is loopback, local browser origins continue to be accepted as before.

## Troubleshooting

A rejected upgrade logs:

```
[verify-client] verifyClient: origin not allowed (origin not allowed)
```

If a legitimate browser is rejected: confirm its `Origin` is in `gateway.controlUi.allowedOrigins`, or that loopback/host-header fallback applies for your deployment.
