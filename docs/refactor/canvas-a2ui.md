---
summary: "Refactor: host A2UI from the Gateway (HTTP), remove app-bundled shells"
read_when:
  - Refactoring Canvas/A2UI ownership or assets
  - Moving UI rendering from native bundles into the Gateway
  - Updating node canvas navigation or A2UI command flows
---

# Canvas / A2UI — HTTP-hosted from Gateway

Status: Implemented · Date: 2025-12-20

## Goal
- Make the **Gateway (TypeScript)** the single owner of A2UI.
- Remove **app-bundled A2UI shells** (macOS, iOS, Android).
- A2UI renders only when the **Gateway is reachable** (acceptable failure mode).

## Decision
All A2UI HTML/JS assets are **served by the Gateway HTTP server** (single port,
same as the Gateway WebSocket). Nodes (mac/iOS/Android) **navigate to the
Gateway URL** before applying A2UI messages. No local custom-scheme or bundled
fallback remains.

## Why
- One source of truth (TS) for A2UI rendering.
- Faster iteration (no app release required for A2UI updates).
- iOS/Android/macOS all behave identically.

## New behavior (summary)
1) `canvas.a2ui.*` on any node:
   - Ensure Canvas is visible.
   - Navigate the node WebView to the Gateway A2UI URL.
   - Apply/reset A2UI messages once the page is ready.
2) If Gateway is unreachable:
   - A2UI fails with an explicit error (no fallback).

## Gateway changes

### Serve A2UI assets
Add A2UI HTML/JS to the Gateway Canvas host (same HTTP server as the Gateway
WS), e.g.:

```
/__clawdis__/a2ui/           -> index.html
/__clawdis__/a2ui/a2ui.bundle.js -> bundled A2UI runtime
```

Serve Canvas files at `/__clawdis__/canvas/` and A2UI at `/__clawdis__/a2ui/`.
Use the shared Canvas host handler (`src/canvas-host/server.ts`) to serve these
assets and inject the action bridge + live reload if desired.

### Derive HTTP host from WebSocket
Nodes derive the Canvas host URL from the Gateway WS URL:

```
ws://host:port  -> http://host:port
wss://host:port -> https://host:port
```

The Gateway exposes a **canonical** `canvasHostUrl` in hello/bridge payloads
so nodes don’t need to guess.

## Node changes (mac/iOS/Android)

### Navigation path
Before applying A2UI:
- Navigate to `${canvasHostUrl}/__clawdis__/a2ui/`.

### Remove bundled shells
Remove all fallback logic that serves A2UI from local bundles:
- macOS: remove custom-scheme fallback for `/__clawdis__/a2ui/`
- iOS/Android: remove packaged A2UI assets and "default scaffold" assumptions

### Error behavior
If `canvasHostUrl` is missing or unreachable:
- `canvas.a2ui.push/reset` returns a clear error:
  - `A2UI_HOST_UNAVAILABLE` or `A2UI_HOST_NOT_CONFIGURED`

## Security / transport
- For non-TLS Gateway URLs (http), iOS/Android will need ATS exceptions.
- For TLS (https), prefer WSS + HTTPS with a valid cert.

## Implementation plan
1) Gateway
   - Add A2UI assets under `src/canvas-host/`.
   - Serve them at `/__clawdis__/a2ui/` (align with existing naming).
   - Serve Canvas files at `/__clawdis__/canvas/` on the Gateway port.
   - Expose `canvasHostUrl` in handshake + bridge hello payloads.
2) Node runtimes
   - Update `canvas.a2ui.*` to navigate to `canvasHostUrl`.
   - Remove custom-scheme A2UI fallback and bundled assets.
3) Tests
   - TS: verify `/__clawdis__/a2ui/` responds with HTML + JS.
   - Node: verify A2UI fails when host is unreachable and succeeds when reachable.
4) Docs
   - Update `docs/mac/canvas.md`, `docs/ios/spec.md`, `docs/android/connect.md`
     to remove local fallback assumptions and point to gateway-hosted A2UI.

## Notes
- iOS/Android may still require ATS exceptions for `http://` canvas hosts.
