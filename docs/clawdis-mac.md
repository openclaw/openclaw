# Clawdis macOS Companion (menu bar + XPC broker)

Author: steipete · Status: draft spec · Date: 2025-12-05

## Purpose
- Single macOS menu-bar app named **Clawdis** that:
  - Shows native notifications for Clawdis/clawdis events.
  - Owns TCC prompts (Notifications, Accessibility, Screen Recording, Automation/AppleScript, Microphone, Speech Recognition).
  - Brokers privileged actions (screen capture, shell with elevated UI context) via XPC.
  - Provides a tiny CLI (`clawdis-mac`) that talks to the app; Node/TS shells out to it.
- Replace the separate notifier helper pattern (Oracle) with a built-in notifier.
- Offer a first-run experience similar to VibeTunnel’s onboarding (permissions + CLI install).

## High-level design
- SwiftPM package in `apps/macos/` (macOS 15+, Swift 6):
  - Dependency: `https://github.com/ChimeHQ/AsyncXPCConnection` (>=0.6.0).
  - Targets:
    - `ClawdisIPC` (shared Codable types + helpers).
    - `Clawdis` (LSUIElement MenuBarExtra app; embeds XPC listener and notifier).
    - `ClawdisCLI` (client that forms requests, talks XPC, prints JSON for scripts).
- Bundle ID: `com.steipete.clawdis`; XPC service name: `com.steipete.clawdis.xpc`.
- The CLI lives in the app bundle `Contents/Helpers/clawdis-mac`; dev symlink `bin/clawdis-mac` points there.
- Node/TS layer calls the CLI; no direct XPC from Node.

## IPC contract (ClawdisIPC)
- Codable enums; small payloads (<1 MB enforced in listener):

```
enum Capability { notifications, accessibility, screenRecording, appleScript, microphone, speechRecognition }
enum Request {
  notify(title, body, sound?)
  ensurePermissions([Capability], interactive: Bool)
  screenshot(displayID?, windowID?, format="png")
  runShell(command:[String], cwd?, env?, timeoutSec?, needsScreenRecording: Bool)
  status
}
struct Response { ok: Bool; message?: String; payload?: Data }
```
- Listener validates caller `auditToken` == same UID, rejects oversize/unknown cases.

## App UX (Clawdis)
- MenuBarExtra icon only (LSUIElement; no Dock).
- Menu items: Status, Permissions…, **Pause Clawdis** toggle (temporarily deny privileged actions/notifications without quitting), Quit.
- Settings window (Trimmy-style tabs):
- General: launch at login toggle and debug/visibility toggles (no per-user default sound; pass sounds per notification via CLI).
  - Permissions: live status + “Request” buttons for Notifications/Accessibility/Screen Recording; links to System Settings.
  - Debug (when enabled): PID/log links, restart/reveal app shortcuts, manual test notification.
  - About: version, links, license.
- Pause behavior: matches Trimmy’s “Auto Trim” toggle. When paused, XPC listener returns `ok=false, message="clawdis paused"` for actions that would touch TCC (notify/run/screenshot). State is persisted (UserDefaults) and surfaced in menu and status view.
- Onboarding (VibeTunnel-inspired): Welcome → What it does → Install CLI (shows `ln -s .../clawdis-mac /usr/local/bin`) → Permissions checklist with live status → Test notification → Done. Re-show when `welcomeVersion` bumps or CLI/app version mismatch.

## Built-in services
- NotificationManager: UNUserNotificationCenter primary; AppleScript `display notification` fallback; respects the `--sound` value on each request.
- PermissionManager: checks/requests Notifications, Accessibility (AX), Screen Recording (capture probe); publishes changes for UI.
- ScreenCaptureManager: window/display PNG capture; gated on permission.
- ShellExecutor: executes `Process` with timeout; rejects when `needsScreenRecording` and permission missing; returns stdout/stderr in payload.
- XPCListener actor: routes Request → managers; logs via OSLog.

## CLI (`clawdis-mac`)
- Subcommands (JSON out, non-zero exit on failure):
  - `notify --title --body [--sound]`
  - `ensure-permissions --cap accessibility --cap screenRecording [--interactive]`
  - `screenshot [--display-id N | --window-id N] [--out path]`
  - `run -- cmd args... [--cwd] [--env KEY=VAL] [--timeout 30] [--needs-screen-recording]`
  - `status`
- Sounds: supply any macOS alert name with `--sound` per notification; omit the flag to use the system default. There is no longer a persisted “default sound” in the app UI.
- Internals: builds Request, connects via AsyncXPCConnection, prints Response as JSON to stdout.

## Integration with clawdis/Clawdis (Node/TS)
- Add helper module that shells to `clawdis-mac`:
  - Prefer `ensure-permissions` before actions that need TCC.
  - Use `notify` for desktop toasts; fall back to JS notifier only if CLI missing or platform ≠ macOS.
  - Use `run` for tasks requiring privileged UI context (screen-recorded terminal runs, etc.).

## Permissions strategy
- All TCC prompts originate from the app bundle; CLI and Node stay headless.
- Permission checks are idempotent; onboarding surfaces missing grants and provides one-click request buttons.

## Build & dev workflow (native)
- `cd native && swift build` (debug) / `swift build -c release`.
- Run app for dev: `swift run Clawdis` (or Xcode scheme).
- Package app + helper: `swift build -c release && swift package --allow-writing-to-directory ../dist` (tbd exact script).
- Tests: add Swift Testing suites under `apps/macos/Tests` (especially IPC round-trips and permission probing fakes).

## Icon pipeline
- Source asset lives at `apps/macos/Icon.icon` (glass .icon bundle).
- Regenerate the bundled icns via `scripts/build_icon.sh` (uses ictool/icontool + sips), which outputs to
  `apps/macos/Sources/Clawdis/Resources/Clawdis.icns` by default. Override `DEST_ICNS` to change the target.
  The script also writes intermediate renders to `apps/macos/build/icon/`.

## Open questions / decisions
- Where to place the dev symlink `bin/clawdis-mac` (repo root vs. `apps/macos/bin`)?
- Should `runShell` support streaming stdout/stderr (XPC with AsyncSequence) or just buffered? (Start buffered; streaming later.)
- Icon: reuse Clawdis lobster or new mac-specific glyph?
- Sparkle updates: bundled via Sparkle; release builds point at `https://raw.githubusercontent.com/steipete/clawdis/main/appcast.xml` and enable auto-checks, while debug builds leave the feed blank and disable checks.
