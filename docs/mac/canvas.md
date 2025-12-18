---
summary: "Agent-controlled Canvas panel embedded via WKWebView + custom URL scheme"
read_when:
  - Implementing the macOS Canvas panel
  - Adding agent controls for visual workspace
  - Debugging WKWebView canvas loads
---

# Canvas (macOS app)

Status: draft spec · Date: 2025-12-12

Note: for iOS/Android nodes that should render agent-edited HTML/CSS/JS over the network, prefer the Gateway `canvasHost` (serves `~/clawd/canvas` over LAN/tailnet with live reload). This doc focuses on the macOS in-app canvas panel. See `docs/configuration.md`.

Clawdis can embed an agent-controlled “visual workspace” panel (“Canvas”) inside the macOS app using `WKWebView`, served via a **custom URL scheme** (no loopback HTTP port required).

This is designed for:
- Agent-written HTML/CSS/JS on disk (per-session directory).
- A real browser engine for layout, rendering, and basic interactivity.
- Agent-driven visibility (show/hide), navigation, DOM/JS queries, and snapshots.
- Minimal chrome: borderless panel; bezel/chrome appears only on hover.

## Why a custom scheme (vs. loopback HTTP)

Using `WKURLSchemeHandler` keeps Canvas entirely in-process:
- No port conflicts and no extra local server lifecycle.
- Easier to sandbox: only serve files we explicitly map.
- Works offline and can use an ephemeral data store (no persistent cookies/cache).

If a Canvas page truly needs “real web” semantics (CORS, fetch to loopback endpoints, service workers), consider the loopback-server variant instead (out of scope for this doc).

## URL ↔ directory mapping

The Canvas scheme is:
- `clawdis-canvas://<session>/<path>`

Routing model:
- `clawdis-canvas://main/` → `<canvasRoot>/main/index.html` (or `index.htm`)
- `clawdis-canvas://main/yolo` → `<canvasRoot>/main/yolo/index.html` (or `index.htm`)
- `clawdis-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`

Directory listings are not served.

When `/` has no `index.html` yet, the handler serves a **built-in A2UI shell** (bundled with the macOS app).
This gives the agent a ready-to-render UI surface without requiring any on-disk HTML.

If the A2UI shell resources are missing (dev misconfiguration), Canvas falls back to a simple built-in welcome page.

### Reserved built-in paths

The scheme handler serves bundled assets under:
- `clawdis-canvas://<session>/__clawdis__/a2ui/...`

This is reserved for app-owned assets (not session content) and is backed by `Bundle.module` resources.

### Suggested on-disk location

Store Canvas state under the app support directory:
- `~/Library/Application Support/Clawdis/canvas/<session>/…`

This keeps it alongside other app-owned state and avoids mixing with `~/.clawdis/` gateway config.

## Panel behavior (agent-controlled)

Canvas is presented as a borderless `NSPanel` (similar to the existing WebChat panel):
- Can be shown/hidden at any time by the agent.
- Supports an “anchored” presentation (near the menu bar icon or another anchor rect).
- Uses a rounded container; shadow stays on, but **chrome/bezel only appears on hover**.
- Default position is the **top-right corner** of the current screen’s visible frame (unless the user moved/resized it previously).
- The panel is **user-resizable** (edge resize + hover resize handle) and the last frame is persisted per session.

### Hover-only chrome

Implementation notes:
- Keep the window borderless at all times (don’t toggle `styleMask`).
- Add an overlay view inside the content container for chrome (stroke + subtle gradient/material).
- Use an `NSTrackingArea` to fade the chrome in/out on `mouseEntered/mouseExited`.
- Optionally show close/drag affordances only while hovered.

## Agent API surface (proposed)

Expose Canvas via the existing `clawdis-mac` → control socket → app routing so the agent can:
- Show/hide the panel.
- Navigate to a path (relative to the session root).
- Evaluate JavaScript and optionally return results.
- Query/modify DOM (helpers mirroring “dom query/all/attr/click/type/wait” patterns).
- Capture a snapshot image of the current canvas view.
- Optionally set panel placement (screen `x/y` + `width/height`) when showing/navigating.

This should be modeled after `WebChatManager`/`WebChatSwiftUIWindowController` but targeting `clawdis-canvas://…` URLs.

Related:
- For “invoke the agent again from UI” flows, prefer the macOS deep link scheme (`clawdis://agent?...`) so *any* UI surface (Canvas, WebChat, native views) can trigger a new agent run. See `docs/clawdis-mac.md`.

## Agent commands (current)

`clawdis-mac` exposes Canvas via the control socket. For agent use, prefer `--json` so you can read the structured `CanvasShowResult` (including `status`).

- `clawdis-mac canvas show [--session <key>] [--target <...>] [--x/--y/--width/--height]`
  - Local targets map into the session directory via the custom scheme (directory targets resolve `index.html|index.htm`).
  - If `/` has no index file, Canvas shows the built-in A2UI shell and returns `status: "a2uiShell"`.
- `clawdis-mac canvas hide [--session <key>]`
- `clawdis-mac canvas eval --js <code> [--session <key>]`
- `clawdis-mac canvas snapshot [--out <path>] [--session <key>]`

### Canvas A2UI

Canvas includes a built-in **A2UI v0.8** renderer (Lit-based). The agent can drive it with JSONL **server→client protocol messages** (one JSON object per line):

- `clawdis-mac canvas a2ui push --jsonl <path> [--session <key>]`
- `clawdis-mac canvas a2ui reset [--session <key>]`

`push` expects a JSONL file where **each line is a single JSON object** (parsed and forwarded to the in-page A2UI renderer).

Minimal example (v0.8):

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOF'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, `canvas a2ui push` works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOF

clawdis-mac canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --session main
```

Notes:
- This does **not** support the A2UI v0.9 examples using `createSurface`.

## Triggering agent runs from Canvas (deep links)

Canvas can trigger new agent runs via the macOS app deep-link scheme:
- `clawdis://agent?...`

This is intentionally separate from `clawdis-canvas://…` (which is only for serving local Canvas files into the `WKWebView`).

Suggested patterns:
- HTML: render links/buttons that navigate to `clawdis://agent?message=...`.
- JS: set `window.location.href = 'clawdis://agent?...'` for “run this now” actions.

Implementation note (important):
- In `WKWebView`, intercept `clawdis://…` navigations in `WKNavigationDelegate` and forward them to the app, e.g. by calling `DeepLinkHandler.shared.handle(url:)` and returning `.cancel` for the navigation.

Safety:
- Deep links (`clawdis://agent?...`) are always enabled.
- Without a `key` query param, the app will prompt for confirmation before invoking the agent.
- With a valid `key`, the run is unattended (no prompt). For Canvas-originated actions, the app injects an internal key automatically.

## Security / guardrails

Recommended defaults:
- `WKWebsiteDataStore.nonPersistent()` for Canvas (ephemeral).
- Navigation policy: allow only `clawdis-canvas://…` (and optionally `about:blank`); open `http/https` externally.
- Scheme handler must prevent directory traversal: resolved file paths must stay under `<canvasRoot>/<session>/`.
- Disable or tightly scope any JS bridge; prefer query-string/bootstrap config over `window.webkit.messageHandlers` for sensitive data.

## Debugging

Suggested debugging hooks:
- Enable Web Inspector for Canvas builds (same approach as WebChat).
- Log scheme requests + resolution decisions to OSLog (subsystem `com.steipete.clawdis`, category `Canvas`).
- Provide a “copy canvas dir” action in debug settings to quickly reveal the session directory in Finder.
