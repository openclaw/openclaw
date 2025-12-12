---
summary: "Agent-controlled Canvas panel embedded via WKWebView + custom URL scheme"
read_when:
  - Implementing the macOS Canvas panel
  - Adding agent controls for visual workspace
  - Debugging WKWebView canvas loads
---

# Canvas (macOS app)

Status: draft spec · Date: 2025-12-12

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

When `/` has no `index.html` yet, the handler serves a built-in welcome page with:
- The resolved on-disk session directory path.
- A short “create index.html” hint.

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

Expose Canvas via the existing `clawdis-mac` → XPC → app routing so the agent can:
- Show/hide the panel.
- Navigate to a path (relative to the session root).
- Evaluate JavaScript and optionally return results.
- Query/modify DOM (helpers mirroring “dom query/all/attr/click/type/wait” patterns).
- Capture a snapshot image of the current canvas view.
- Optionally set panel placement (screen `x/y` + `width/height`) when showing/navigating.

This should be modeled after `WebChatManager`/`WebChatWindowController` but targeting `clawdis-canvas://…` URLs.

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
