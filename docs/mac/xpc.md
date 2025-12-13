---
summary: "macOS XPC architecture for Clawdis app, CLI helper, and gateway bridge"
read_when:
  - Editing XPC contracts or menu bar app IPC
---
# Clawdis macOS XPC architecture (Dec 2025)

Note: the current implementation primarily uses a local UNIX-domain control socket (`controlSocketPath`) between `clawdis-mac` and the app. This doc describes the intended long-term XPC/Mach-service architecture and the security constraints; update it as the implementation converges.

## Goals
- Single GUI app instance that owns all TCC-facing work (notifications, screen recording, mic, speech, AppleScript).
- A small surface for automation: the `clawdis-mac` CLI and the Node gateway talk to the app via a local XPC channel.
- Predictable permissions: always the same signed bundle ID, launched by launchd, so TCC grants stick.
- Limit who can connect: only signed clients from our team (with an explicit DEBUG-only escape hatch for development).

## How it works
- The app registers a Mach service named `com.steipete.clawdis.xpc` via a user LaunchAgent at `~/Library/LaunchAgents/com.steipete.clawdis.plist`.
- The launch agent runs `dist/Clawdis.app/Contents/MacOS/Clawdis` with `RunAtLoad=true`, `KeepAlive=false`, and a `MachServices` entry for the XPC name.
- The app hosts the XPC listener (`NSXPCListener(machServiceName:)`) and exports `ClawdisXPCService`.
- The CLI (`clawdis-mac`) connects with `NSXPCConnection(machServiceName:)`; the Node gateway shells out to the CLI.
- Security: on incoming connections we read the audit token (or PID) and allow only:
  - Code-signed clients with team ID `Y5PE65HELJ`.
  - In `DEBUG` builds only, you can opt into allowing same-UID clients by setting `CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS=1`.

## Operational flows
- Restart/rebuild: `SIGN_IDENTITY="Apple Development: Peter Steinberger (2ZAC4GM7GD)" scripts/restart-mac.sh`
  - Kills existing instances
  - Swift build + package
  - Writes/bootstraps/kickstarts the LaunchAgent
- CLI version: `clawdis-mac --version` (pulled from `package.json` during packaging)
- Single instance: app exits early if another instance with the same bundle ID is running.

## Why launchd (not anonymous endpoints)
- A Mach service avoids brittle endpoint handoffs and lets the CLI/Node connect even if the app was started by launchd.
- RunAtLoad without KeepAlive means the app starts once; if it crashes it stays down (no unwanted respawn), but CLI calls will re-spawn via launchd.

## Hardening notes
- Prefer requiring a TeamID match for all privileged surfaces. The codebase currently has a `DEBUG`-only same-UID escape hatch gated behind `CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` for local development.
- All communication remains local-only; no network sockets are exposed.
- TCC prompts originate only from the GUI app bundle; run scripts/package-mac-app.sh so the signed bundle ID stays stable.
