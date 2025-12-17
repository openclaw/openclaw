---
summary: "Spec for the Clawdis macOS companion menu bar app and local broker (control socket + PeekabooBridge)"
read_when:
  - Implementing macOS app features
  - Touching broker/CLI bridging
---
# Clawdis macOS Companion (menu bar + local broker)

Author: steipete · Status: draft spec · Date: 2025-12-05

## Purpose
- Single macOS menu-bar app named **Clawdis** that:
  - Shows native notifications for Clawdis/clawdis events.
  - Owns TCC prompts (Notifications, Accessibility, Screen Recording, Automation/AppleScript, Microphone, Speech Recognition).
  - Brokers privileged actions via local IPC:
    - Clawdis control socket (app-specific actions like notify/run)
    - PeekabooBridge socket (`bridge.sock`) for UI automation brokering (consumed by `peekaboo`; see `docs/mac/peekaboo.md`)
  - Provides a tiny CLI (`clawdis-mac`) that talks to the app; Node/TS shells out to it.
- Replace the separate notifier helper pattern (Oracle) with a built-in notifier.
- Offer a first-run experience similar to VibeTunnel’s onboarding (permissions + CLI install).

## High-level design
- SwiftPM package in `apps/macos/` (macOS 15+, Swift 6).
- Targets:
  - `ClawdisIPC` (shared Codable types + helpers for app-specific commands).
  - `Clawdis` (LSUIElement MenuBarExtra app; hosts control socket + optional PeekabooBridgeHost).
  - `ClawdisCLI` (`clawdis-mac`; prints text by default, `--json` for scripts).
- Bundle ID: `com.steipete.clawdis`.
- The CLI lives in the app bundle `Contents/Helpers/clawdis-mac`; dev symlink `bin/clawdis-mac` points there.
- Node/TS layer calls the CLI; no direct privileged API calls from Node.

Note: `docs/mac/xpc.md` describes an aspirational long-term Mach/XPC architecture. The current direction for UI automation is PeekabooBridge (socket-based).

## IPC contract (ClawdisIPC)
- Codable enums; small payloads (<1 MB enforced in listener):

```
enum Capability { notifications, accessibility, screenRecording, appleScript, microphone, speechRecognition }
enum Request {
  notify(title, body, sound?)
  ensurePermissions([Capability], interactive: Bool)
  runShell(command:[String], cwd?, env?, timeoutSec?, needsScreenRecording: Bool)
  status
}
struct Response { ok: Bool; message?: String; payload?: Data }
```
- The control-socket server rejects oversize/unknown cases and validates the caller by code signature TeamID (with a `DEBUG`-only same-UID escape hatch controlled by `CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`).

UI automation is not part of `ClawdisIPC.Request`:
- UI automation is handled via the separate PeekabooBridge socket and is surfaced by the `peekaboo` CLI (see `docs/mac/peekaboo.md`).

## App UX (Clawdis)
- MenuBarExtra icon only (LSUIElement; no Dock).
- Menu items: Status, Permissions…, **Pause Clawdis** toggle (temporarily deny privileged actions/notifications without quitting), Quit.
- Settings window (Trimmy-style tabs):
- General: launch at login toggle and debug/visibility toggles (no per-user default sound; pass sounds per notification via CLI).
  - Permissions: live status + “Request” buttons for Notifications/Accessibility/Screen Recording; links to System Settings.
  - Debug (when enabled): PID/log links, restart/reveal app shortcuts, manual test notification.
  - About: version, links, license.
- Pause behavior: matches Trimmy’s “Auto Trim” toggle. When paused, the broker returns `ok=false, message="clawdis paused"` for actions that would touch TCC. State is persisted (UserDefaults) and surfaced in menu and status view.
- Onboarding (VibeTunnel-inspired): Welcome → What it does → Install CLI (shows `ln -s .../clawdis-mac /usr/local/bin`) → Permissions checklist with live status → Test notification → Done. Re-show when `welcomeVersion` bumps or CLI/app version mismatch.

## Built-in services
- NotificationManager: UNUserNotificationCenter primary; AppleScript `display notification` fallback; respects the `--sound` value on each request.
- PermissionManager: checks/requests Notifications, Accessibility (AX), Screen Recording (capture probe); publishes changes for UI.
- UI automation + capture: provided by **PeekabooBridgeHost** when enabled (see `docs/mac/peekaboo.md`).
- ShellExecutor: executes `Process` with timeout; rejects when `needsScreenRecording` and permission missing; returns stdout/stderr in payload.
- ControlSocketServer actor: routes Request → managers; logs via OSLog.

## CLI (`clawdis-mac`)
- Subcommands (text by default; `--json` for machine output; non-zero exit on failure):
  - `notify --title --body [--sound] [--priority passive|active|timeSensitive] [--delivery system|overlay|auto]`
  - `ensure-permissions --cap accessibility --cap screenRecording [--interactive]`
  - UI automation + capture: use `peekaboo …` (Clawdis hosts PeekabooBridge; see `docs/mac/peekaboo.md`)
  - `run -- cmd args... [--cwd] [--env KEY=VAL] [--timeout 30] [--needs-screen-recording]`
  - `status`
  - Nodes (bridge-connected companions):
    - `node list` — lists paired + currently connected nodes, including advertised capabilities (e.g. `canvas`, `camera`).
    - `node invoke --node <id> --command <name> [--params-json <json>]`
- Sounds: supply any macOS alert name with `--sound` per notification; omit the flag to use the system default. There is no longer a persisted “default sound” in the app UI.
- Priority: `timeSensitive` is best-effort and falls back to `active` unless the app is signed with the Time Sensitive Notifications entitlement.
- Delivery: `overlay` and `auto` show an in-app toast panel (bypasses Notification Center/Focus).
- Internals:
  - For app-specific commands (`notify`, `ensure-permissions`, `run`, `status`): build `ClawdisIPC.Request`, send over the control socket.
  - UI automation is intentionally not exposed via `clawdis-mac`; it lives behind PeekabooBridge and is surfaced by the `peekaboo` CLI.

## Integration with clawdis/Clawdis (Node/TS)
- Add helper module that shells to `clawdis-mac`:
  - Prefer `ensure-permissions` before actions that need TCC.
  - Use `notify` for desktop toasts; fall back to JS notifier only if CLI missing or platform ≠ macOS.
  - Use `run` for tasks requiring privileged UI context (screen-recorded terminal runs, etc.).
  - For UI automation, shell out to `peekaboo …` (text by default; add `--json` for structured output) and rely on PeekabooBridge host selection (Peekaboo.app → Clawdis.app → local).

## Deep links (URL scheme)

Clawdis (the macOS app) registers a URL scheme for triggering local actions from anywhere (browser, Shortcuts, CLI, etc.).

Scheme:
- `clawdis://…`

### `clawdis://agent`

Triggers a Gateway `agent` request (same machinery as WebChat/agent runs).

Example:

```bash
open 'clawdis://agent?message=Hello%20from%20deep%20link'
```

Query parameters:
- `message` (required): the agent prompt (URL-encoded).
- `sessionKey` (optional): explicit session key to use.
- `thinking` (optional): thinking hint (e.g. `low`; omit for default).
- `deliver` (optional): `true|false` (default: false).
- `to` / `channel` (optional): forwarded to the Gateway `agent` method (only meaningful with `deliver=true`).
- `timeoutSeconds` (optional): timeout hint forwarded to the Gateway.
- `key` (optional): unattended mode key (see below).

Safety/guardrails:
- Always enabled.
- Without a `key` query param, the app will prompt for confirmation before invoking the agent.
- With `key=<value>`, Clawdis runs without prompting (intended for personal automations).
  - The current key is shown in Debug Settings and stored locally in UserDefaults.

Notes:
- In local mode, Clawdis will start the local Gateway if needed before issuing the request.
- In remote mode, Clawdis will use the configured remote tunnel/endpoint.

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
- Should `runShell` support streaming stdout/stderr (IPC with AsyncSequence) or just buffered? (Start buffered; streaming later.)
- Icon: reuse Clawdis lobster or new mac-specific glyph?
- Sparkle updates: bundled via Sparkle; release builds point at `https://raw.githubusercontent.com/steipete/clawdis/main/appcast.xml` and enable auto-checks, while debug builds leave the feed blank and disable checks.
