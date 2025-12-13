---
summary: "Plan for integrating Peekaboo automation into Clawdis via PeekabooBridge (socket-based TCC broker)"
read_when:
  - Adding UI automation commands
  - Integrating Peekaboo as a submodule
  - Changing clawdis-mac IPC/output formats
---
# Peekaboo Bridge in Clawdis (macOS UI automation broker)

## TL;DR
- **Peekaboo removed its XPC helper** and now exposes privileged automation via a **UNIX domain socket bridge** (`PeekabooBridge` / `PeekabooBridgeHost`, socket name `bridge.sock`).
- Clawdis integrates by **hosting the same bridge** inside **Clawdis.app** (optional, user-toggleable), and by making `clawdis-mac ui …` act as a **bridge client**.
- For **visualizations**, we keep them in **Peekaboo.app** (best UX); Clawdis stays a thin broker host. No visualizer toggle in Clawdis.

Non-goals:
- No auto-launching Peekaboo.app.
- No onboarding deep links from the automation endpoint (Clawdis onboarding already handles permissions).
- No AI provider/agent runtime dependencies in Clawdis (avoid pulling Tachikoma/MCP into the Clawdis app/CLI).

## Big refactor (Dec 2025): XPC → Bridge
Peekaboo’s privileged execution moved from “CLI → XPC helper” to “CLI → socket bridge host”. For Clawdis this is a win:
- It matches the existing “local socket + codesign checks” approach.
- It lets us piggyback on **either** Peekaboo.app’s permissions **or** Clawdis.app’s permissions (whichever is running).
- It avoids “two apps with two TCC bubbles” unless needed.

Reference (Peekaboo submodule): `docs/bridge-host.md`.

## Architecture
### Processes
- **Bridge hosts** (provide TCC-backed automation):
  - **Peekaboo.app** (preferred; also provides visualizations + controls)
  - **Clawdis.app** (secondary; “thin host” only)
- **Bridge clients** (trigger single actions):
  - `clawdis-mac ui …`
  - `clawdis ui …` (Node/TS convenience wrapper; shells out to `clawdis-mac ui …`)
  - Node/Gateway shells out to `clawdis-mac`

### Host discovery (client-side)
Order is deliberate:
1. Peekaboo.app host (full UX)
2. Clawdis.app host (piggyback on Clawdis permissions)

Socket paths (convention; exact paths must match Peekaboo):
- Peekaboo: `~/Library/Application Support/Peekaboo/bridge.sock`
- Clawdis: `~/Library/Application Support/clawdis/bridge.sock`

No auto-launch: if a host isn’t reachable, the command fails with a clear error (start Peekaboo.app or Clawdis.app).

Override (debugging): set `PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock`.

### Protocol shape
- **Single request per connection**: connect → write one JSON request → half-close → read one JSON response → close.
- **Timeout**: 10 seconds end-to-end per action (client enforced; host should also enforce per-operation).
- **Errors**: human-readable string by default; structured envelope in `--json`.

## Dependency strategy (submodule)
Integrate Peekaboo via git submodule (nested submodules are OK).

Path in Clawdis repo:
- `./Peekaboo` (Swabble-style; keep stable so SwiftPM path deps don’t churn).

What Clawdis should use:
- **Client side**: `PeekabooBridge` (socket client + protocol models).
- **Host side (Clawdis.app)**: `PeekabooBridgeHost` + the minimal Peekaboo services needed to implement operations.

What Clawdis should *not* embed:
- **Visualizer UI**: keep it in Peekaboo.app for now (toggle + controls live there).
- **XPC**: don’t reintroduce helper targets; use the bridge.

## IPC / CLI surface
### Namespacing
Add new automation commands behind a `ui` prefix:
- `clawdis-mac ui …` for UI automation + visualization-related actions.
- Keep existing top-level commands (`notify`, `run`, `canvas …`, etc.) for compatibility.

Screenshot cutover:
- Remove legacy screenshot endpoints/commands.
- Ship only `clawdis-mac ui screenshot` (no aliases).

### Output format
Change `clawdis-mac` to default to human text output:
- **Default**: plain text; errors are string messages to stderr; exit codes indicate success/failure.
- **`--json`**: structured output (for agents/scripts) with stable schemas.

This applies globally, not only `ui` commands.

Note (current state as of 2025-12-13): `clawdis-mac` prints text by default; use `--json` for structured output.

### Timeouts
Default timeout for UI actions: **10 seconds** end-to-end.

## Coordinate model (multi-display)
Requirement: coordinates are **per screen**, not global.

Standardize for the CLI (agent-friendly): **top-left origin per screen**.

Proposed request shape:
- Requests accept `screenIndex` + `{x, y}` in that screen’s local coordinate space.
- Clawdis.app converts to global CG coordinates using `NSScreen.screens[screenIndex].frame.origin`.
- Responses should echo both:
  - The resolved `screenIndex`
  - The local `{x, y}` and bounds
  - Optionally the global `{x, y}` for debugging

Ordering: use `NSScreen.screens` ordering consistently (documented in the CLI help + JSON schema).

## Targeting (per app/window)
Expose window/app targeting in the UI surface (align with Peekaboo targeting):
- frontmost
- by app name / bundle id
- by window title substring
- by (app, index)

Current `clawdis-mac ui …` support:
- `--bundle-id <id>` for app targeting
- `--window-index <n>` (0-based) for disambiguating within an app when capturing (see/screenshot)

All “see/click/type/scroll/wait” requests should accept a target (default: frontmost).

## “See” + click packs (Playwright-style)
Behavior stays aligned with Peekaboo:
- `ui see` returns element IDs (e.g. `B1`, `T3`) with bounds/labels.
- Follow-up actions reference those IDs without re-scanning.

`clawdis-mac ui see` should:
- capture (optionally targeted) window/screen
- return a screenshot **file path** (default: temp directory)
- return a list of elements (text or JSON)

Snapshot lifecycle requirement:
- Host apps are long-lived, so snapshot state should be **in-memory by default**.
- Snapshot scoping: “implicit snapshot” is **per target bundle id** (reuse last snapshot for that app when snapshot id is omitted).

Practical flow (agent-friendly):
- `clawdis-mac ui frontmost` returns the focused app (bundle id) + focused window (title/id) so follow-up calls can pass `--bundle-id …`.
- `clawdis-mac ui see --bundle-id X` updates the implicit snapshot for `X`.
- `clawdis-mac ui click --bundle-id X --on B1` reuses the most recent snapshot for `X` when `--snapshot-id` is omitted.

## Visualizer integration
Keep visualizations in **Peekaboo.app** for now.
- Clawdis hosts the bridge, but does not render overlays.
- Any “visualizer enabled/disabled” setting is controlled in Peekaboo.app.

## Screenshots (legacy → Peekaboo takeover)
Clawdis uses `clawdis-mac ui screenshot` and returns a file path (default location: temp directory) instead of raw image bytes.

Migration plan:
- Bridge host performs capture and returns a temp file path.
- No legacy aliases; make the old screenshot surface disappear cleanly.

## Permissions behavior
If required permissions are missing:
- return `ok=false` with a short human error message (e.g., “Accessibility permission missing”)
- do not try to open System Settings from the automation endpoint

## Security (socket auth)
Both hosts must enforce:
- filesystem perms on the socket path (owner read/write only)
- server-side caller validation:
  - require the caller’s code signature TeamID to be `Y5PE65HELJ`
  - optional bundle-id allowlist for tighter scoping

Debug-only escape hatch (development convenience):
- “allow same-UID callers” means: *skip codesign checks for clients running under the same Unix user*.
- This must be **opt-in**, **DEBUG-only**, and guarded by an env var (Peekaboo uses `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`).

## Current `clawdis-mac ui` commands (Dec 2025)
All commands default to text output. Add `--json` right after `clawdis-mac` for a structured envelope.

- `clawdis-mac ui permissions status`
- `clawdis-mac ui frontmost`
- `clawdis-mac ui apps`
- `clawdis-mac ui windows [--bundle-id <id>]`
- `clawdis-mac ui screenshot [--screen-index <n>] [--bundle-id <id>] [--window-index <n>] [--watch] [--scale native|1x]`
- `clawdis-mac ui see [--bundle-id <id>] [--window-index <n>] [--snapshot-id <id>]`
- `clawdis-mac ui click --on <elementId> [--bundle-id <id>] [--snapshot-id <id>] [--double|--right]`
- `clawdis-mac ui type --text <value> [--into <elementId>] [--bundle-id <id>] [--snapshot-id <id>] [--clear] [--delay-ms <n>]`
- `clawdis-mac ui wait --on <elementId> [--bundle-id <id>] [--snapshot-id <id>] [--timeout <sec>]`

## Next integration steps (after this doc)
1. Add Peekaboo as a git submodule (nested submodules OK).
2. Add a small `clawdis-mac ui …` surface that speaks PeekabooBridge (text by default, `--json` for structured).
3. Host `PeekabooBridgeHost` inside Clawdis.app behind a single setting (“Enable Peekaboo Bridge”, default on).
4. Implement the minimum operation set needed for agents (see/click/type/scroll/wait/screenshot, plus list apps/windows/screens).
5. Keep all protocol decisions aligned with Peekaboo (coordinate system, element IDs, snapshot scoping, error envelopes).
