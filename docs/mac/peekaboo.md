---
summary: "Plan for integrating Peekaboo automation + visualizer into Clawdis macOS app (via clawdis-mac)"
read_when:
  - Adding UI automation commands
  - Integrating Peekaboo as a submodule
  - Changing clawdis-mac IPC/output formats
---
# Peekaboo in Clawdis (macOS UI automation + visualizer)

## Goal
Reuse Peekaboo’s mac automation “core” inside **Clawdis.app** so we piggyback on Clawdis’ existing TCC grants (Screen Recording, Accessibility, etc.). The CLI (`clawdis-mac`) stays a thin synchronous trigger surface for **single actions** (no batches), returning errors cleanly.

Non-goals:
- No AI/agent runtime parts from Peekaboo (no Tachikoma/MCP/Commander entrypoints).
- No auto-onboarding or System Settings deep-linking from the automation layer (Clawdis onboarding already handles that).

## Where code lives
- **Clawdis.app (macOS)**: owns all automation + visualization + TCC prompts.
- **`clawdis-mac` CLI**: sends one request, waits, prints result, exits non-zero on failure.
- **Gateway/Node/TS**: shells out to `clawdis-mac` when it needs TCC-backed actions.

Transport: existing UNIX domain socket (`controlSocketPath`) already used by `clawdis-mac`.

## Dependencies (submodule strategy)
Integrate Peekaboo via git submodule (nested submodules OK).

Consume only:
- `PeekabooAutomationKit` (AX automation, element detection, capture helpers; no Tachikoma/MCP).
- `AXorcist` (input driving / AX helpers).
- `PeekabooVisualizer` (overlay visualizations).

Important nuance:
- `PeekabooAutomationKit` is a standalone SwiftPM package and does **not** require Tachikoma/MCP/Commander.
- `PeekabooVisualizer` ships as a product inside `PeekabooCore/Package.swift`. That package declares other dependencies (including a path dependency to Tachikoma). SwiftPM will still need those paths to exist during dependency resolution even if we don’t build those targets.
  - If this becomes annoying for Clawdis, the follow-up is to extract `PeekabooVisualizer` into its own standalone Swift package that depends only on `PeekabooFoundation`/`PeekabooProtocols`/`PeekabooExternalDependencies`.

## IPC / CLI surface
### Namespacing
Add new automation commands behind a `ui` prefix:
- `clawdis-mac ui …` for UI automation + visualization-related actions.
- Keep existing top-level commands (`notify`, `run`, `canvas …`, etc.) for compatibility, but do a clean cutover for screenshots: remove the legacy top-level `screenshot` command and ship only `clawdis-mac ui screenshot`.

### Output format
Change `clawdis-mac` to default to human text output:
- **Default**: plain text; errors are string messages to stderr; exit codes indicate success/failure.
- **`--json`**: structured output (for agents/scripts) with stable schemas.

This applies globally, not only `ui` commands.

Note (current state as of 2025-12-13): `clawdis-mac` prints JSON by default. This is a planned behavior change.

### Timeouts
Default timeout for UI actions: **10 seconds** end-to-end (CLI already defaults to 10s).
- CLI: keep the fail-fast default at 10s (unless a command explicitly requests longer).
- Server: only has a ~5s read/decode timeout today; UI operations must also enforce their own per-action timeout so “wait for element” can fail deterministically.

## Coordinate model (multi-display)
Requirement: coordinates are **per screen**, not global.

Proposed API shape:
- Requests accept `screenIndex` + `{x, y}` in that screen’s local coordinate space.
- Clawdis.app converts to global CG coordinates using `NSScreen.screens[screenIndex].frame.origin`.
- Responses should echo both:
  - The resolved `screenIndex`
  - The local `{x, y}` and bounds
  - Optionally the global `{x, y}` for debugging

Ordering: use `NSScreen.screens` ordering consistently (documented in the CLI help + JSON schema).

## Targeting (per app/window)
Expose window/app targeting in the IPC surface (based on Peekaboo’s existing `WindowTarget` model):
- frontmost
- by app name / bundle id
- by window title substring
- by (app, index)
- by window id

All “see/click/type/scroll/wait” requests should accept a target (default: frontmost).

## “See” + click packs (Playwright-style)
Peekaboo already has the core ingredients:
- element detection yielding stable IDs (e.g., `B1`, `T3`)
- bounds + labels/values
- snapshot IDs to allow follow-up actions without re-scanning

Clawdis’s `ui see` should:
- capture (optionally targeted) window/screen
- return a **snapshot id**
- return a list of elements with `{id, type, label/value?, bounds}`
- optionally return screenshot path/bytes (pref: path)

Snapshot lifecycle requirement:
- Clawdis runs long-lived in memory, so “snapshot state” should be **in-memory by default** (no disk-backed JSON concept).
- Peekaboo already supports this via an `InMemorySnapshotManager` (keep disk-backed snapshots as an optional debug mode later).

## Visualizer integration
Visualizer must be user-toggleable via a Clawdis setting.

Implementation sketch:
- Add a Clawdis UserDefaults-backed setting (e.g. `clawdis.ui.visualizerEnabled`).
- Implement Peekaboo’s `VisualizerSettingsProviding` in Clawdis (`visualizerEnabled`, animation speed, and per-effect toggles).
- Create a Clawdis-specific `AutomationFeedbackClient` that forwards PeekabooAutomationKit feedback events into a shared `VisualizerCoordinator`.

Current state:
- `PeekabooVisualizer` already includes the visualization implementation (SwiftUI overlay views + coordinator).
The visualizer is intentionally display-only (no clickable overlays needed).

## Screenshots (legacy → Peekaboo takeover)
Clawdis currently has a legacy `screenshot` request returning raw PNG bytes in `Response.payload`.

Migration plan:
- Replace capture implementation with PeekabooAutomationKit’s capture service so we share:
  - per-screen mapping
  - window/app targeting
  - visual feedback (flash / watch HUD) when enabled
- Prefer writing images to a file path on the app side and returning the path (text-friendly), with `--json` providing the structured metadata.
- No aliases: remove the old `Request.screenshot` and introduce a new `Request.uiScreenshot` (or similar) so the new behavior is explicit and there’s no “legacy mode” to maintain.

## Permissions behavior
If required permissions are missing:
- return `ok=false` with a short human error message (e.g., “Accessibility permission missing”)
- do not try to open System Settings from the automation endpoint

## Security (socket auth)
Clawdis’ socket is protected by:
- filesystem perms on the socket path (owner read/write only)
- server-side caller check:
  - requires the caller’s code signature TeamID to be `Y5PE65HELJ`
  - in `DEBUG` builds only, an explicit escape hatch allows same-UID clients when `CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` is set (development convenience)

This ensures “any local process” can’t drive the privileged surface just because it runs under the same macOS user.

## Next integration steps (after this doc)
1. Add Peekaboo as a git submodule (and required nested submodules).
2. Wire SwiftPM deps in `apps/macos/Package.swift` to import `PeekabooAutomationKit` + `PeekabooVisualizer`.
3. Extend `ClawdisIPC.Request` with `ui.*` commands (`see/click/type/scroll/wait/screenshot/windows/screens`).
4. Implement handlers in Clawdis.app and route through PeekabooAutomationKit services.
5. Update `clawdis-mac` output defaults (text + `--json`), and adjust any internal call sites that relied on JSON-by-default.
