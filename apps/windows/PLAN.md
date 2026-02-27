# OpenClaw Windows Node - Development Plan

## Objective
Build a native Windows application that replicates the functionality of the OpenClaw macOS companion app, using C# and .NET 8 targeting Windows 10/11 natively.

## Naming convention
- Foundation/protocol layer: **Core** (e.g., `CoreMethodService`).
- System capability layer (next phase): **Api** naming for platform adapters/services.

## Current Snapshot (latest)
- ✅ Windows solution scaffolded: `OpenClaw.sln`
- ✅ Projects created: `OpenClaw.Node`, `OpenClaw.Node.Tests`
- ✅ Real Gateway handshake working against local gateway (`hello-ok` confirmed)
- ✅ Core frame protocol aligned to gateway `req/res/event` flow
- ✅ Method routing scaffold implemented
- ✅ `node.invoke.request` receive + `node.invoke.result` send implemented with command executor (`system.run`, `system.which`, `system.notify`, `screen.list`, `screen.record`, `camera.list`, `camera.snap`, `window.list`, `window.focus`, `window.rect`, `input.type`, `input.key`, `input.click`, `input.scroll`, `input.click.relative`)
- ✅ Pairing pending state can be populated from gateway events (`device.pair.requested`, `node.pair.requested`)
- ✅ Config loading added (args/env/`~/.openclaw/openclaw.json`)
- ✅ Phase 2 started with first end-to-end media slice
- ✅ `screen.record` upgraded to timed MP4 recording path (base64 mp4 payload with duration/fps/audio metadata)
- ✅ `screen.record` resilient native capture tuning added (`captureApi`, `lowLatency`, and fallback attempts: requested API hardware-on -> requested API hardware-off -> desktop-duplication low-latency)
- ✅ Real-host camera validation completed (`camera.snap` generic + explicit `deviceId`; front/back semantics tolerate single-camera hosts; `maxWidth`/`quality` verified)
- ✅ Pending pairing cache now persisted on disk (`~/.openclaw/identity/pending-pairs.json`) and reloaded on restart
- ✅ Phase 3 discovery MVP added: UDP multicast beacon announcer (`openclaw.node.discovery.v1`) with immediate+periodic broadcasts and gateway/capabilities metadata payload
- ✅ Phase 3 discovery step 2 added: listener/index for discovered nodes, stale-entry expiry, reconnect/network-change reannounce policy, and announce throttle/jitter behavior
- ✅ Phase 3 IPC hardening pass added: per-request timeout handling (`TIMEOUT`), cancellation propagation into process execution, and concurrent client stability coverage
- ✅ Tests passing (95 total) (including onboarding advisor checks + parse-error path, discovery beacon shape/timer coverage + stale-expiry/throttle coverage, IPC timeout/concurrency coverage, tray-status broadcaster coverage, pairing persistence tests + device-auth connect assertions + node.invoke.result request-path assertion; real-gateway suite previously validated)
- ✅ **Phase 1–4 MVP scope complete** (remaining items are optional polish/follow-ups)
- ✅ Removed `MediaFoundation.Net` NU1701 warning path from build by moving camera stack off framework-only package

---

## Phase 1: Core Networking & Protocol (Completed)
- [x] Scaffold .NET 8 solution and base app
- [x] Add protocol models (`ConnectParams`, `RequestFrame`, `ResponseFrame`, `EventFrame`)
- [x] Implement WebSocket connection loop
- [x] Handle `connect.challenge` and send `connect` request
- [x] Confirm real gateway `hello-ok` handshake
- [x] Implement request-method router scaffold (`status`, `health`)
- [x] Add bridge models + `node.invoke.request` event handling scaffold
- [x] Return structured `res` envelopes (`ok/payload/error`)
- [x] Add token/url resolution from args/env/config file
- [x] Add robust reconnect backoff and tick/heartbeat miss handling parity with macOS
- [x] Add full method coverage parity (core Phase 1 method set)
- [x] Replace hardcoded client identity shim with Windows-native allowed client id strategy

### Phase 1 method coverage queue (next)
1. ✅ `status`
2. ✅ `health`
3. ✅ `set-heartbeats`
4. ✅ `system-event`
5. ✅ `channels.status`
6. ✅ `config.get` / `config.set` / `config.patch` / `config.schema`
7. ✅ `node.pair.*` + `device.pair.*` implemented with pending request cache (list/approve/reject over pending request set, now persisted to disk)

---

## Phase 2: System Capabilities (Media & Automation APIs) (Completed)
- **Screen/Capture (`Media/`)**
  - [x] `screen.list` bridge command wired in `NodeCommandExecutor` with display metadata payload
  - [x] `screen.record` bridge command wired in `NodeCommandExecutor`
  - [x] Timed recording parameters handled: `durationMs`, `fps`, `includeAudio`, `screenIndex`
  - [x] Returns OpenClaw-compatible payload shapes:
    - `screen.list` -> `{ displays: [{ index, id, name }] }`
    - `screen.record` -> `{ format: "mp4", base64, durationMs, fps, screenIndex, hasAudio, captureApi, hardwareEncoding, lowLatency }`
  - [x] Initial MP4 recording implementation uses `ScreenRecorderLib` (Windows Media Foundation-backed)
  - [x] Evaluate/iterate native implementation details (WGC vs Desktop Duplication behavior tuning) with capture-api selection + resilient fallback attempts (hardware-on -> hardware-off -> desktop-duplication low-latency)
- **Camera (`Media/`)**
  - [x] `camera.list` bridge command wired in `NodeCommandExecutor` with device metadata payload
  - [x] `camera.snap` bridge command wired in `NodeCommandExecutor`
  - [x] Returns OpenClaw-compatible payload shapes:
    - `camera.list` -> `{ devices: [{ id, name, position, deviceType }] }`
    - `camera.snap` -> `{ format: "jpg", base64, width, height }`
  - [x] Replaced MediaFoundation.Net camera path with net8-safe native WinRT backend (PowerShell bridge) and optional bundled ffmpeg fallback (no user setup required)
  - [x] Added actionable unavailable error when camera frame cannot be produced (privacy/setup guidance + backend reason)
  - [x] Validate on real Windows host with physical cameras (`camera.snap` generic + explicit `deviceId`, `facing=front/back`, `maxWidth`, `quality`)
- **Automation (`Automation/`)**
  - [x] MVP command set wired (`window.list`, `window.focus`, `window.rect`, `input.type`, `input.key`, `input.click`, `input.scroll`, `input.click.relative`)
  - [x] `window.list` returns `{ windows: [{ handle, title, process, isFocused }] }`
  - [x] `window.focus` supports `handle` or `titleContains`
  - [x] `input.type` text injection path via SendInput Unicode events
  - [x] `input.key` key combo path via SendInput virtual keys (e.g., `ctrl+v`, `enter`, `alt+f4`)
  - [x] `input.click` mouse click path with `button=primary|secondary|left|right` and optional `doubleClick`
  - [x] `input.scroll` wheel path with required `deltaY` and optional `{ x, y }` targeting
  - [x] Primary/secondary click semantics respect OS swapped-button setting (left-handed mode)
  - [x] Added richer UIAutomation element-level actions (`ui.find`, `ui.click`, `ui.type`) beyond coordinate/keystroke MVP
- **Shell execution**
  - [x] `System.Diagnostics.Process` command executor with allowlist

---

## Phase 3: Discovery + IPC
- **Discovery**
  - [x] MVP announcer implemented: UDP multicast beacon (`openclaw.node.discovery.v1`) with immediate + periodic broadcasts
  - [x] Beacon payload includes node identity, version, commands, capabilities, and gateway endpoint metadata
  - [x] Discovery listener/index + stale-entry expiry model
  - [x] Re-announce policy on reconnect/network changes + jitter/backoff tuning
- **IPC**: Named Pipes bridge replacing macOS XPC
  - [x] Named pipe server lifecycle integrated into app start/stop
  - [x] IPC auth token support added (shared secret on request envelope)
  - [x] IPC method parity reached for current automation MVP:
    - `ipc.ping`
    - `ipc.window.list`, `ipc.window.focus`, `ipc.window.rect`
    - `ipc.input.type`, `ipc.input.key`, `ipc.input.click`, `ipc.input.scroll`, `ipc.input.click.relative`
  - [x] Per-request timeout model added (`params.timeoutMs`, clamped) with explicit `TIMEOUT` error responses
  - [x] Cancellation propagation into process-exec path (`RunProcessAsync` kill-on-cancel best effort)
  - [x] Unit tests added for pipe roundtrip + unknown-method + auth gating + bad-request validation paths
  - [x] Added IPC hardening tests:
    - timeout behavior on slow method
    - concurrent client ping load

---

## Phase 4: UI / Tray / Onboarding
- [x] Step 1 scaffold: tray-status runtime wiring added (`TrayStatusBroadcaster` + `ITrayHost` + `NoOpTrayHost`) with `--tray` flag and state transitions (Starting/Connected/Reconnecting/Disconnected/Stopped)
- [x] Step 2: concrete Windows `NotifyIcon` tray host added (`WindowsNotifyIconTrayHost`) with menu actions (Open Logs / Restart Node / Exit) and lifecycle status text updates
- [x] Step 3 (MVP): tray status details surfaced (`State`, `Pending pairs`, `Last reconnect`) + quick diagnostics copy action
- [x] Step 4 (onboarding MVP, slice 1): startup onboarding checks surfaced in tray + guided `Open Config` action
- [x] Step 5 (onboarding MVP, slice 2): default tray startup on Windows + missing-token dialog + config-parse-aware onboarding status (auto-restart onboarding action removed per UX preference)
- [x] Step 6 (onboarding MVP, wrap): auth-mismatch dialog path covered + calmer copy polish; onboarding MVP marked complete
- [x] Settings/onboarding flows (MVP complete; additional polish tracked separately)
- [x] Overlay/HUD equivalents (de-scoped from core MVP; optional follow-up)

---

## Testing Strategy
- ✅ Unit tests running via xUnit
- ✅ Current tests: protocol serialization/deserialization + bridge shape checks
- ✅ Added WebSocket dispatch tests with mocked gateway handshake + status request roundtrip
- ✅ Added unhandled-method error-path dispatch test (`INVALID_REQUEST`)
- ✅ Added handler-exception dispatch test (`UNAVAILABLE`)
- ✅ Added invalid-param tests for pairing handlers
- ✅ Added opt-in live gateway integration tests (`RUN_REAL_GATEWAY_INTEGRATION=1`) for:
  - real hello-ok connect path
  - real `status` command response path
- ✅ Added pairing event-ingestion tests (`device.pair.requested`, `node.pair.requested`, `*.pair.resolved`)
- ✅ Added platform-aware `screen.record` command test coverage (Windows success shape + non-Windows success fallback)
- ✅ Added `camera.snap` payload-shape test coverage
- ✅ Added `CameraCaptureService` coverage for baseline capture contract output
- ✅ Added opt-in real gateway integration coverage for `camera.snap` response-shape path when a connected node is available
- ✅ Added opt-in real gateway integration coverage for `screen.record` response-shape path when a connected node is available
- ✅ Added `camera.snap` parameter validation coverage (facing/format/quality invalid-request paths)
- ✅ Added `screen.record` parameter validation coverage (duration/fps/includeAudio/screenIndex/type invalid-request paths)
- ✅ Added `camera.list` command coverage (unit + opt-in real gateway response-shape path when a node is available)
- ✅ Added stricter `camera.list`/device-field shape assertions (unit + real gateway when devices are present)
- ✅ Added `screen.list` command coverage (unit + service-shape + opt-in real gateway response-shape path when a node is available)
- ✅ Added opt-in real gateway `screen.record` coverage using explicit `screenIndex` from `screen.list` when available
- ✅ Added automation MVP coverage (`window.list`, `window.focus`, `window.rect`, `input.type`, `input.key`, `input.click`, `input.scroll`, `input.click.relative`) with unit validation + opt-in real gateway `window.list/window.rect` response-shape paths
- ✅ Added signed device-identity handshake on `connect.challenge` (`device.id/publicKey/signature/signedAt/nonce`) so node role can enter real pairing flow
- ✅ Added opt-in real gateway `camera.snap` coverage using explicit `deviceId` from `camera.list` when available
- ✅ Added Named Pipe IPC unit coverage (`ipc.ping` roundtrip + unknown method + auth gating)
- ✅ Added dev workflow helper commands:
  - `screen.capture` (capture primary-screen jpg + focused window metadata)
