# Feature Parity: macOS vs Windows — MVP scope

> macOS ref: `openclaw/apps/macos/Sources/OpenClaw/`
> Windows: `openclaw/apps/windows/src/`

This document covers the **MVP surface** — what this Windows port delivers and defends.
Partial/follow-up areas are listed separately at the bottom.

---

## MVP parity

### Install & launch

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| Package format | `.app` bundle (signed, notarized) | MSIX single-project (`dotnet build -p:PackageMsix=true`) | Functional |
| Install method | Drag to /Applications or Homebrew | `Add-AppxPackage` / double-click MSIX via App Installer | Functional |
| First run | `OnboardingWizard` (gateway-driven) | `OnboardingWindow` — gateway-driven wizard (`wizard.start/next/cancel` RPC); skips automatically if already configured | Parity |
| Tray icon appears | `MenuBarExtra` in `OpenClawApp` | `WinUIEx.TrayIcon` created in `App.OnLaunched` + invisible `KeepAliveWindow` | Functional |
| Quit | `NSApp.terminate` | `Application.Current.Exit()` in `QuitAsync` | Functional |

**Verification:** MSIX installs, app launches, tray icon visible, OnboardingWindow shows on first run (gateway-driven wizard), Settings opens, Quit works. Tested on x64.

### Tray runtime

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| Left click | Opens chat panel (`WebChatManager.togglePanel`) | Opens chat panel (`IWebChatManager.TogglePanelAsync`) | Parity |
| Right click | NSMenu native popup | Custom `WindowEx` — acrylic backdrop, auto-hide on deactivate, multi-monitor positioning | Adapted |
| Connection toggle | `connectionLabel` toggle + dot + health status | Same: `CheckBox` + dot + `HealthStatusLabel` | Parity |
| Pairing badges | Pending count (orange) for node + device | Same: `PairingStatusText` + `DevicePairingStatusText` | Parity |
| Toggles | Heartbeats, Browser Control, Camera, Canvas, Voice Wake, Exec Approvals (Deny/Ask/Allow) | All present with matching bindings | Parity |
| Actions | Dashboard, Chat, Canvas, Talk Mode, Settings, Quit | All present | Parity |
| Nodes section | Gateway row + connected devices + loading/empty states | Same: `NodesMenuSection` with 4 states (not connected, loading, empty, list) | Parity |
| Context card | `MenuContextCardInjector` — session usage bars | `ContextMenuCardView` — rows + loading state + status text | Parity |
| Usage + cost | `UsageMenuLabelView` + `CostUsageMenuView` | `MenuUsageHeaderView` + `UsageMenuLabelView` + `CostUsageMenuView` | Parity |
| Debug menu | Conditional on `debugPaneEnabled` — 14 items | Same structure, 14 items, conditional visibility | Parity |
| Menu closes on focus loss | `NSMenu` does this natively | `Deactivated` event → `Hide()` + `SetForegroundWindow` P/Invoke | Adapted |
| Tooltip | Icon state reflects connection | `TrayIconPresenter` handles `TrayMenuStateChangedEvent` — shows "Connected | main" etc. | Parity |

### Gateway lifecycle

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| WebSocket connect | `GatewayChannelActor` — `client.id="cli"`, `client.mode="cli"`, 5 operator scopes | `GatewayReceiveLoopHostedService` — same `client.id`, `mode`, scopes | Parity |
| Hello-ok handshake | Extracts `sessionKey`, applies settings | Same: `ApplyHelloOk` stores session key, triggers health poll | Parity |
| Health polling | `HealthStore` timer | `HealthPollingHostedService` — 3s until first snapshot, then 60s | Parity |
| Reconnect | `GatewayConnectivityCoordinator` with retry | `GatewayReconnectCoordinatorHostedService` with Polly exponential backoff | Adapted |
| Config hot-reload | `ConfigFileWatcher` (FSEvents) | `SettingsFileWatcher` (FileSystemWatcher). Fix: no longer triggers connection mode change on hot-reload | Adapted |
| Push events | `GatewayPushSubscription` — `agent`, `health`, `exec`, `pairing`, `cron` | `IGatewayMessageRouter` dispatches to MediatR handlers | Adapted |
| Channels polling | `ChannelsStore` timer | `ChannelsStatusPollingHostedService` | Parity |
| Nodes polling | `NodesStore` timer | `NodesPollingHostedService` | Parity |
| Instances polling | `InstancesStore` timer | `InstancesPollingHostedService` | Parity |
| Cron polling | `CronJobsStore` timer | `CronJobsPollingHostedService` | Parity |

**Key difference:** macOS uses a single `GatewayConnection` actor with auto-retry. Windows separates concerns into hosted services with independent lifecycles. Same net behavior.

### Node mode (system.run, camera, canvas, screen)

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| Node coordinator | `MacNodeModeCoordinator` | `WindowsNodeModeCoordinator` — same backoff, caps, permissions, TLS TOFU | Parity |
| Device identity | Ed25519 via Security.framework | Ed25519 via `BouncyCastle.Cryptography` + DPAPI persistence | Adapted |
| `system.run` | `handleSystemRun` — process spawn, stdout/stderr streaming, timeout | `HandleSystemRunAsync` — same with `ProcessStartInfo` | Parity |
| `system.which` | `handleSystemWhich` — PATH resolution | `HandleSystemWhichAsync` | Parity |
| `system.notify` | `handleSystemNotify` — native notification | `HandleSystemNotifyAsync` — Windows toast notification | Adapted |
| `system.execApprovals.get/set` | Named pipe RPC | Named pipe RPC (`NamedPipeExecApprovalAdapter`) | Adapted |
| `camera.list/snap/clip` | AVFoundation `CameraCaptureService` | WinRT `MediaCapture` adapter | Adapted |
| `screen.record` | `CGWindowListCreateImage` | `Windows.Graphics.Capture` API | Adapted |
| `canvas.*` (8 commands) | `CanvasManager` + WebKit views | WebView2 host — present/hide/navigate/eval/snapshot/a2ui.push/pushJSONL/reset | Parity |
| `location.get` | CoreLocation | Windows `Geolocator` | Adapted |
| `browser.proxy` | `MacNodeBrowserProxy` — HTTP fetch proxy | `BrowserProxyCommand` + `HttpClient` | Parity |

### Exec approvals

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| IPC transport | Unix domain socket | Named pipe (`\\.\pipe\openclaw-exec-...`) | Adapted |
| Frame protocol | 4-byte LE length prefix + JSON | Same (`NamedPipeFrame`) | Parity |
| Allowlist matcher | `ExecAllowlistMatcher.swift` | `ExecAllowlistMatcherService.cs` | Parity |
| Shell wrapper parser | `ExecShellWrapperParser.swift` | `ExecShellWrapperParser.cs` | Parity |
| Env sanitizer | `HostEnvSanitizer.swift` | `HostEnvSanitizer.cs` | Parity |
| Approval modes | Deny / Ask / Allow | Same — configurable from tray + settings | Parity |

### Pairing

| Aspect | macOS | Windows | Status |
|--------|-------|---------|--------|
| Node pairing | `NodePairingApprovalPrompter` — approve/reject via gateway RPC | `NodePairingOrchestratorHostedService` — same RPC flow | Parity |
| Device pairing | `DevicePairingApprovalPrompter` — approve/reject | `DevicePairingOrchestratorHostedService` | Parity |
| Device identity | Ed25519 keypair, persisted in Keychain | Ed25519 keypair, persisted with DPAPI in `%APPDATA%\OpenClaw\keypair.dpapi` | Adapted |

### Settings UI

macOS tabs: General, Channels, VoiceWake, Config, Instances, Sessions, Cron, Skills, Permissions, Debug, About (11).
Windows tabs: General, Channels, Sessions, Permissions, VoiceWake, Config, **Security**, Skills, Instances, Cron, Debug, About (12).

Windows adds a dedicated **Security** tab for exec approval configuration (macOS handles this inline). All macOS tabs present.

### CI & packaging

| Aspect | Detail |
|--------|--------|
| CI workflows | `ci-x64.yml`, `ci-arm64.yml`, `release.yml`, `security.yml` — all rewritten for .NET 10 + single-project MSIX |
| Artifacts | MSIX for x64 and ARM64 |
| SDK | .NET 10.0.200 via `global.json` + Windows App SDK 1.8 |
| Tests in CI | `dotnet test --no-build` with `.trx` upload (`if: always()`) |
| Sign | Placeholder — verifies MSIX exists, logs path + size. Real signing to be done by maintainer |

---

## Out of MVP scope

These areas exist in code but are **not part of the PR's MVP claim**. They work to varying degrees but are not the focus.

| Area | Current state | Follow-up |
|------|--------------|-----------|
| **Voice Wake (hotword)** | Stub — SPIKE-004: Porcupine SDK not verified on Windows/ARM64. STT talk mode works | Needs Porcupine integration or Windows Speech alternative |
| **Talk mode overlay** | STT + gateway forwarding work. No visual overlay UI | UI work |
| **Push-to-talk** | Not implemented | Global hotkey registration |
| **Session submenus** | Session list present. No preview popover, no actions (thinking/verbose/reset/compact/delete) | UI complexity — can be added post-merge |
| **Channel login/logout** | Channels page shows status (read-only). No `web.login.start`/`wait`/`channels.logout` RPC | Needs OAuth flow UI |
| **Critter icon animation** | Static `.ico` files per state. No animated critter/badge/attention dot | Custom icon renderer — cosmetic |
| **Hover HUD** | No tooltip expansion on hover | WinUI3 limitation |
| **Auto-update** | MSIX version bump works. No Sparkle-equivalent auto-updater | MSIX model — separate concern |
| **`models.list` RPC** | Not implemented | Low priority — not used in tray or settings |

---

## Bugs found during parity verification

None.
