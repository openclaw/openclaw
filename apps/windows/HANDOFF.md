# Handoff - OpenClaw Windows Node

## Repo path
`<repo-root>/apps/windows`

## What works now

## MVP status
- ✅ Core 4-phase plan is complete (Phase 1–4 delivered).
- ✅ Remaining work is optional polish/follow-up, not phase-blocking.

1. `OpenClaw.Node` builds/runs.
2. Connects to real local OpenClaw gateway and completes handshake (`hello-ok`).
3. Receives `connect.challenge`, sends `connect` request in gateway frame format.
4. Supports method router handlers for:
   - `status`
   - `health`
   - `set-heartbeats`
   - `system-event`
   - `channels.status`
   - `config.get`
   - `config.set`
   - `config.patch`
   - `config.schema`
   - `node.pair.list` / `node.pair.approve` / `node.pair.reject`
   - `device.pair.list` / `device.pair.approve` / `device.pair.reject`
5. Supports `node.invoke.request` ingestion and emits `node.invoke.result` with actual execution for:
   - `system.run`
   - `system.which`
   - `system.notify`
   - `screen.capture` (captures primary-screen jpg + focused window metadata)
   - `screen.list` (Phase 2: returns display metadata list `{ index, id, name }`)
   - `screen.record` (Phase 2 timed MP4 path: returns base64 mp4 with recording metadata)
   - `camera.list` (Phase 2: returns device metadata list `{ id, name, position, deviceType }`)
   - `camera.snap` (Phase 2: jpg payload shape with native WinRT capture and optional bundled ffmpeg fallback; returns actionable unavailable error with backend reason if capture/privacy setup is missing)
   - `window.list` (Automation MVP: returns `{ windows: [{ handle, title, process, isFocused }] }`)
   - `window.focus` (Automation MVP: focus by `handle` or `titleContains`)
   - `window.rect` (Automation MVP: returns `{ rect: { handle, left, top, right, bottom, width, height } }`)
   - `input.type` (Automation MVP: SendInput Unicode text injection into focused window)
   - `input.key` (Automation MVP: SendInput virtual-key combos into focused window)
   - `input.click` (Automation MVP: mouse click at `{ x, y }` with `button=primary|secondary|left|right` + optional `doubleClick`; primary/secondary respect OS swapped-button setting)
   - `input.scroll` (Automation MVP: vertical wheel scroll with `deltaY` and optional coordinate targeting `{ x, y }`)
   - `input.click.relative` (Automation MVP: click at window-relative offsets `{ offsetX, offsetY }` using `handle` or `titleContains`)
   - `ui.find` (Automation v2: selector-based element lookup by `name` / `automationId` / `controlType`)
   - `ui.click` (Automation v2: selector-based element click)
   - `ui.type` (Automation v2: selector-based element focus+type)
6. Local IPC named-pipe server is running on Windows (`\\.\pipe\openclaw.node.ipc`) with auth + methods:
   - `ipc.ping`
   - `ipc.window.list`
   - `ipc.window.focus`
   - `ipc.window.rect`
   - `ipc.input.type`
   - `ipc.input.key`
   - `ipc.input.click`
   - `ipc.input.scroll`
   - `ipc.input.click.relative`
   - per-request timeout support via `params.timeoutMs` (clamped); timeout returns `TIMEOUT`
   - auth token required when configured (Program currently uses gateway token as shared secret)
7. Phase 3 discovery is active:
   - `DiscoveryService` sends UDP multicast node beacons to `239.255.77.77:18791`
   - schema: `openclaw.node.discovery.v1`
   - payload includes node id/display name/platform/version/instanceId + gateway host/port/scheme + advertised commands/capabilities
   - lifecycle: immediate beacon on service start, periodic beacons every 30s (+ jitter), and reannounce on gateway connect/network-change (throttled)
   - listener/index enabled: consumes discovery beacons, tracks remote nodes in-memory, and purges stale entries (default stale window ~95s)
8. Phase 4 tray implementation started:
   - Added tray runtime state model (`Starting/Connected/Reconnecting/Disconnected/Stopped`)
   - Added `TrayStatusBroadcaster` and `ITrayHost` abstraction
   - Added `NoOpTrayHost` fallback and `WindowsNotifyIconTrayHost` concrete implementation
   - `--tray` startup flag now enables tray mode with Windows menu actions:
     - Open Logs (opens `~/.openclaw`)
     - Open Config (opens/creates `~/.openclaw/openclaw.json`)
     - Copy Diagnostics (clipboard snapshot: state, onboarding status, pending pairs, reconnect timing, uptime, pid)
     - Restart Node (graceful cancel + relaunch schedule)
     - Exit
   - Tray status text follows gateway lifecycle/log events
   - Tray status details section now shows:
     - State
     - Pending pairs
     - Last reconnect duration
     - Onboarding status
   - Onboarding MVP (slice 1): startup checks for token/url/config-file now feed tray onboarding status (`OnboardingAdvisor`)
   - Missing-token behavior improved: app no longer exits immediately in default Windows tray mode; it stays alive in tray with warning/status and `Open Config` path (`--no-tray` disables this)
   - Missing-token UX now includes a Windows warning dialog (`MessageBox` with OK) to guide recovery even when no console is visible
   - Gateway auth failure detection hardened: dialog now triggers on explicit connect rejection, auth-like connect failures (e.g., 401/403), and pre-hello socket closes to cover mismatch cases that previously showed no dialog
   - Removed auto-restart onboarding action to keep setup flow non-pressured; recovery remains explicit via `Open Config` + manual `Restart Node`
   - Onboarding checks now distinguish config parse/schema issues (invalid JSON, missing `gateway`/`gateway.auth.token`, non-numeric `gateway.port`) and surface them in onboarding status
   - Onboarding MVP is functionally complete: missing-token + auth-mismatch dialogs, explicit Open Config flow, manual restart control, and polished tray copy
   - Custom tray icon asset now bundled (`openclaw-claw.ico`) and loaded at runtime (fallback to system icon if unavailable)
   - Windows tray target now builds as `WinExe` (`net8.0-windows`) so launching tray app does not open a console window
9. Gateway URL/token resolution works from:
   - CLI args: `--gateway-url`, `--gateway-token`
   - env: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`
   - config fallback: `~/.openclaw/openclaw.json`

## Current caveats
- Node now connects using node identity (`client.id = node-host`, role/mode = node).
- Basic command execution exists (`system.run`, `system.which`, `system.notify`) and Phase 2 now includes `screen.record` timed MP4 recording via `ScreenRecorderLib` plus `camera.snap` via native WinRT capture/list (PowerShell bridge) with optional bundled ffmpeg fallback if packaged.
- `screen.record` tuning now supports `captureApi` (best-effort), `lowLatency`, and resilient fallback attempts (hardware-on -> hardware-off -> desktop-duplication low-latency) to improve reliability across hosts/drivers.
- Real-host camera validation is complete for current hardware (single USB webcam): `camera.snap` works in generic and explicit `deviceId` modes; `facing=front/back` may map to the same physical camera semantics on single-camera hosts; `maxWidth` and `quality` controls are verified.
- Camera path no longer depends on `MediaFoundation.Net`; this removes the `NU1701` framework-compat warning path for `net8.0` builds.
- Build/test currently require x64 platform selection when running commands from CLI in this environment (e.g. `-p:Platform=x64`) because `ScreenRecorderLib` does not support AnyCPU.
- Pairing pending state is filled from broadcast events (`device.pair.requested`, `node.pair.requested`) and cleared on `*.pair.resolved` via `CoreMethodService.HandleGatewayEvent`.
- Pairing pending cache is now persisted locally at `~/.openclaw/identity/pending-pairs.json` and reloaded on process start (best-effort load/persist).
- Reconnect loop now uses exponential backoff (up to 30s) and a background monitor correctly tracks `tick` frames from the server, closing to trigger reconnect if a tick is missed by >5s tolerance.

## Tests
- Project: `OpenClaw.Node.Tests`
- Current total: **95 passing** (plus real-gateway integration suite passing with device-auth handshake)

Run:
```bash
cd <repo-root>/apps/windows
dotnet build OpenClaw.Node/OpenClaw.Node.csproj -p:Platform=x64
dotnet test OpenClaw.Node.Tests/OpenClaw.Node.Tests.csproj -p:Platform=x64
```

## Run app locally
```bash
cd <repo-root>/apps/windows/OpenClaw.Node
dotnet run -p:Platform=x64 -- --gateway-url ws://127.0.0.1:18789 --gateway-token <TOKEN>
```

(or rely on env/config auto-resolution)

## Dev workflow (avoid manual restarts)
PowerShell scripts are available under `scripts/`:
- `node-watchdog.ps1` — keeps Node running and auto-restarts on exit/disconnect.
- `node-reload.ps1` — pause watchdog, stop node, optional git pull + build, unpause watchdog.
- `node-watchdog-install-task.ps1` — optional Scheduled Task installer (run watchdog at login).

Typical flow on Windows host:
```powershell
# one-time watchdog start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\node-watchdog.ps1

# after each code change
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\node-reload.ps1
```

## Immediate next steps
1. Keep running `RUN_REAL_GATEWAY_INTEGRATION=1 dotnet test --filter "FullyQualifiedName~RealGatewayIntegrationTests" -p:Platform=x64` before major merges (now with signed device-auth handshake on connect; suite covers node-connect/status plus screen.list/camera.list/window.list/window.rect response-shape paths, screen.record generic + explicit screenIndex path, and camera.snap generic + explicit deviceId/front-back shape paths when available).
2. On Windows hosts, ensure camera prerequisites are explicit in onboarding/docs: Camera privacy toggles enabled for desktop apps.
3. Extend camera validation on true multi-camera hardware (distinct front/back/external) to tune device-selection heuristics beyond single-camera semantics.
4. Pairing pending cache is already persisted to disk (`~/.openclaw/identity/pending-pairs.json`) and reloaded on startup.
