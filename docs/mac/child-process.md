---
summary: "Running the gateway as a child process of the macOS app and why"
read_when:
  - Integrating the mac app with the gateway lifecycle
---
# Clawdis gateway as a child process of the macOS app

Date: 2025-12-06 · Status: draft · Owner: steipete

## Goal
Run the Node-based Clawdis/clawdis gateway as a direct child of the LSUIElement app (instead of a launchd agent) while keeping all TCC-sensitive work inside the Swift app/XPC and wiring the existing “Clawdis Active” toggle to start/stop the child.

## When to prefer the child-process mode
- You want gateway lifetime strictly coupled to the menu-bar app (dies when the app quits) and controlled by the “Clawdis Active” toggle without touching launchd.
- You’re okay giving up login persistence/auto-restart that launchd provides, or you’ll add your own backoff loop.
- You want simpler log capture and supervision inside the app (no external plist or user-visible LaunchAgent).

## Tradeoffs vs. launchd
- **Pros:** tighter coupling to UI state; simpler surface (no plist install/bootout); easier to stream stdout/stderr; fewer moving parts for beta users.
- **Cons:** no built-in KeepAlive/login auto-start; app crash kills gateway; you must build your own restart/backoff; Activity Monitor will show both processes under the app; still need correct TCC handling (see below).
- **TCC:** behaviorally, child processes often inherit the parent app’s “responsible process” for TCC, but this is *not a contract*. Continue to route all protected actions through the Swift app/XPC so prompts stay tied to the signed app bundle.

## TCC guardrails (must keep)
- Screen Recording, Accessibility, mic, and speech prompts must originate from the Swift app/XPC. The Node child should never call these APIs directly; use the existing XPC/CLI broker (`clawdis-mac`) for:
  - `ensure-permissions`
  - `screenshot` / ScreenCaptureKit work
  - mic/speech permission checks
  - notifications
  - shell runs that need `needs-screen-recording`
- Usage strings (`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, etc.) stay in the app target’s Info.plist; a bare Node binary has none and would fail.
- If you ever embed Node that *must* touch TCC, wrap that call in a tiny signed helper target inside the app bundle and have Node exec that helper instead of calling the API directly.

## Process manager design (Swift Subprocess)
- Add a small `GatewayProcessManager` (Swift) that owns:
  - `execution: Execution?` from `Swift Subprocess` to track the child.
  - `start(config)` called when “Clawdis Active” flips ON:
    - binary: host Node running the bundled gateway under `Clawdis.app/Contents/Resources/Gateway/`
    - args: current clawdis entrypoint and flags
    - cwd/env: point to `~/.clawdis` as today; inject the expanded PATH so Homebrew Node resolves under launchd
    - output: stream stdout/stderr to `/tmp/clawdis-gateway.log` (cap buffer via Subprocess OutputLimits)
    - restart: optional linear/backoff restart if exit was non-zero and Active is still true
  - `stop()` called when Active flips OFF or app terminates: cancel the execution and `waitUntilExit`.
- Wire SwiftUI toggle:
- ON: `GatewayProcessManager.start(...)`
- OFF: `GatewayProcessManager.stop()` (no launchctl calls in this mode)
- Keep the existing `LaunchdManager` around so we can switch back if needed; the toggle can choose between launchd or child mode with a flag if we want both.

## Packaging and signing
- Bundle the gateway payload (dist + production node_modules) under `Contents/Resources/Gateway/`; rely on host Node ≥22 instead of embedding a runtime.
- Codesign native addons and dylibs inside the bundle; no nested runtime binary to sign now.
- Host runtime should not call TCC APIs directly; keep privileged work inside the app/XPC.

## Logging and observability
- Stream child stdout/stderr to `/tmp/clawdis-gateway.log`; surface the last N lines in the Debug tab.
- Emit a user notification (via existing NotificationManager) on crash/exit while Active is true.
- Add a lightweight heartbeat from Node → app (e.g., ping over stdout) so the app can show status in the menu.

## Failure/edge cases
- App crash/quit kills the gateway. Decide if that is acceptable for the deployment tier; otherwise, stick with launchd for production and keep child-process for dev/experiments.
- If the gateway exits repeatedly, back off (e.g., 1s/2s/5s/10s) and give up after N attempts with a menu warning.
- Respect the existing pause semantics: when paused, the XPC should return `ok=false, "clawdis paused"`; the gateway should avoid calling privileged routes while paused.

## Open questions / follow-ups
- Do we need dual-mode (launchd for prod, child for dev)? If yes, gate via a setting or build flag.
- Embedding a runtime is off the table for now; we rely on host Node for size/simplicity. Revisit only if host PATH drift becomes painful.
- Do we want a tiny signed helper for rare TCC actions that cannot be brokered via XPC?

## Decision snapshot (current recommendation)
- Keep all TCC surfaces in the Swift app/XPC.
- Implement `GatewayProcessManager` with Swift Subprocess to start/stop the gateway on the “Clawdis Active” toggle.
- Maintain the launchd path as a fallback for uptime/login persistence until child-mode proves stable. 
