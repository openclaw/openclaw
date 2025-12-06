# Clawdis relay as a child process of the macOS app

Date: 2025-12-06 · Status: draft · Owner: steipete

## Goal
Run the Node-based Clawdis/warelay relay as a direct child of the LSUIElement app (instead of a launchd agent) while keeping all TCC-sensitive work inside the Swift app/XPC and wiring the existing “Clawdis Active” toggle to start/stop the child.

## When to prefer the child-process mode
- You want relay lifetime strictly coupled to the menu-bar app (dies when the app quits) and controlled by the “Clawdis Active” toggle without touching launchd.
- You’re okay giving up login persistence/auto-restart that launchd provides, or you’ll add your own backoff loop.
- You want simpler log capture and supervision inside the app (no external plist or user-visible LaunchAgent).

## Tradeoffs vs. launchd
- **Pros:** tighter coupling to UI state; simpler surface (no plist install/bootout); easier to stream stdout/stderr; fewer moving parts for beta users.
- **Cons:** no built-in KeepAlive/login auto-start; app crash kills relay; you must build your own restart/backoff; Activity Monitor will show both processes under the app; still need correct TCC handling (see below).
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
- Add a small `RelayProcessManager` (Swift) that owns:
  - `execution: Execution?` from `Swift Subprocess` to track the child.
  - `start(config)` called when “Clawdis Active” flips ON:
    - binary: bundled Node or packaged relay CLI under `Clawdis.app/Contents/Resources/Relay/`
    - args: current warelay/clawdis entrypoint and flags
    - cwd/env: point to `~/.clawdis` as today; inject `PATH` if the embedded Node isn’t on PATH
    - output: stream stdout/stderr to `/tmp/clawdis-relay.log` (cap buffer via Subprocess OutputLimits)
    - restart: optional linear/backoff restart if exit was non-zero and Active is still true
  - `stop()` called when Active flips OFF or app terminates: cancel the execution and `waitUntilExit`.
- Wire SwiftUI toggle:
  - ON: `RelayProcessManager.start(...)`
  - OFF: `RelayProcessManager.stop()` (no launchctl calls in this mode)
- Keep the existing `LaunchdManager` around so we can switch back if needed; the toggle can choose between launchd or child mode with a flag if we want both.

## Packaging and signing
- Bundle the relay runtime inside the app:
  - Option A: embed a Node binary + JS entrypoint under `Contents/Resources/Relay/`.
  - Option B: build a single binary via `pkg`/`nexe` and embed that.
- Codesign the embedded runtime as nested code with the same team ID; notarization fails if nested code is unsigned.
- If we keep using Homebrew Node, do *not* let it touch TCC; only the app/XPC should.

## Logging and observability
- Stream child stdout/stderr to `/tmp/clawdis-relay.log`; surface the last N lines in the Debug tab.
- Emit a user notification (via existing NotificationManager) on crash/exit while Active is true.
- Add a lightweight heartbeat from Node → app (e.g., ping over stdout) so the app can show status in the menu.

## Failure/edge cases
- App crash/quit kills the relay. Decide if that is acceptable for the deployment tier; otherwise, stick with launchd for production and keep child-process for dev/experiments.
- If the relay exits repeatedly, back off (e.g., 1s/2s/5s/10s) and give up after N attempts with a menu warning.
- Respect the existing pause semantics: when paused, the XPC should return `ok=false, "clawdis paused"`; the relay should avoid calling privileged routes while paused.

## Open questions / follow-ups
- Do we need dual-mode (launchd for prod, child for dev)? If yes, gate via a setting or build flag.
- Should we embed Node or keep using the system/Homebrew Node? Embedding improves reproducibility and signing hygiene; Homebrew keeps bundle smaller but risks path/sandbox drift.
- Do we want a tiny signed helper for rare TCC actions that cannot be brokered via XPC?

## Decision snapshot (current recommendation)
- Keep all TCC surfaces in the Swift app/XPC.
- Implement `RelayProcessManager` with Swift Subprocess to start/stop the relay on the “Clawdis Active” toggle.
- Maintain the launchd path as a fallback for uptime/login persistence until child-mode proves stable. 
