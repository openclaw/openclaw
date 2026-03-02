# iOS App Architecture, Code Quality & Test Coverage Audit

**Date:** 2026-03-02
**Scope:** `apps/ios/Sources/` (63 files, 16,244 LOC) and `apps/ios/Tests/` (25 files, 1,884 LOC)

---

## Architecture Overview

```
                          OpenClawApp (@main)
                               |
              +----------------+----------------+
              |                                 |
        NodeAppModel                  GatewayConnectionController
       (@Observable)                       (@Observable)
       [God Object]                    [Discovery + Connect]
              |                                 |
  +-----------+-----------+         GatewayDiscoveryModel
  |     |     |     |     |         GatewaySettingsStore
  |     |     |     |     |         GatewayHealthMonitor
  |     |     |     |     |
  v     v     v     v     v
Screen Voice Camera  Services  Gateway Sessions
Ctrl   Wake   Ctrl   (proto)   (node + operator)
       Talk
       Mode

UI Layer (SwiftUI):
  RootCanvas -> ScreenWebView + StatusPill + Overlays
  RootTabs   -> ScreenTab, VoiceTab, SettingsTab
  Onboarding -> OnboardingWizardView, QRScannerView
  Chat       -> ChatSheet (wraps OpenClawChatUI package)

Service Layer (protocols in NodeServiceProtocols.swift):
  CameraServicing, ScreenRecordingServicing, LocationServicing,
  DeviceStatusServicing, PhotosServicing, ContactsServicing,
  CalendarServicing, RemindersServicing, MotionServicing,
  WatchMessagingServicing

Routing: NodeCapabilityRouter (command -> handler dictionary)

Shared Packages: OpenClawKit, OpenClawChatUI, OpenClawProtocol, SwabbleKit
```

---

## Findings by Severity

### CRITICAL

#### C1. NodeAppModel is a God Object (2,787 LOC)
- **File:** `Sources/Model/NodeAppModel.swift`
- **Lines:** 1-2787 (entire file)
- **Description:** NodeAppModel concentrates ~17 distinct responsibilities in a single 2,787-line class:
  1. Gateway WebSocket lifecycle (two sessions: node + operator)
  2. Gateway reconnect state machine with exponential backoff
  3. Background task management (grace periods, leases, suppression)
  4. Deep link handling and agent prompt routing
  5. Voice wake coordination (suspend/resume around other audio)
  6. Talk mode coordination
  7. Camera HUD state management
  8. Screen recording state
  9. Canvas/A2UI invoke handling (present, hide, navigate, evalJS, snapshot, push, reset)
  10. Camera invoke handling (list, snap, clip)
  11. Location invoke handling
  12. Device/Photos/Contacts/Calendar/Reminders/Motion invoke handling
  13. Watch messaging and notification mirroring
  14. Push notification (APNs) token management
  15. Share extension relay configuration
  16. Branding/config refresh from gateway
  17. Session key management and agent selection
- **Impact:** Extremely difficult to test in isolation, reason about, or modify safely. The file already has `// swiftlint:disable type_body_length file_length` which indicates a known but unaddressed problem.
- **Recommendation:** Extract at least these into separate types:
  - `GatewayConnectionLoop` (reconnect state machine, background lease management)
  - `NodeInvokeDispatcher` (all `handleXxxInvoke` methods, currently ~600 LOC)
  - `VoiceAudioCoordinator` (voice wake + talk mode suspend/resume logic)
  - `BackgroundLifecycleManager` (grace periods, suppression, leases)
  - `DeepLinkHandler` (agent prompt, deep link parsing/routing)
  - `PushNotificationManager` (APNs token, notification authorization)

#### C2. TalkModeManager is a God Object (2,153 LOC)
- **File:** `Sources/Voice/TalkModeManager.swift`
- **Lines:** 1-2153 (entire file, saved to disk due to size)
- **Description:** TalkModeManager contains speech recognition, audio playback, gateway communication, provider API key management, push-to-talk state machine, and TTS. The file header acknowledges this: "This file intentionally centralizes talk mode state + behavior. It's large, and splitting would force `private` -> `fileprivate` across many members."
- **Impact:** The `private` -> `fileprivate` concern is valid but solvable with extensions in the same file or a dedicated module with `internal` access.
- **Recommendation:** Extract `TalkAudioPlayer`, `TalkSpeechRecognitionEngine`, `TalkConfigLoader`, `TalkPTTStateMachine` into separate files.

---

### HIGH

#### H1. GatewayConnectionController is oversized (1,058 LOC)
- **File:** `Sources/Gateway/GatewayConnectionController.swift`
- **Lines:** 1-1058
- **Description:** Exceeds the 500 LOC guideline. Mixes discovery coordination, TLS fingerprint verification, Bonjour service resolution, loopback IP detection, URL building, capability/command/permission registration, and auto-connect logic.
- **Recommendation:** Extract `GatewayTLSVerifier`, `LoopbackHostDetector` (static utility), and `GatewayCapabilityRegistrar` (caps/commands/permissions).

#### H2. SettingsTab is oversized (1,032 LOC)
- **File:** `Sources/Settings/SettingsTab.swift`
- **Lines:** 1-1032
- **Description:** A single monolithic SwiftUI view with ~30 `@AppStorage` properties and multiple nested sections.
- **Recommendation:** Extract section views: `GatewaySettingsSection`, `VoiceSettingsSection`, `DeviceSettingsSection`, `AdvancedSettingsSection`.

#### H3. OnboardingWizardView is oversized (884 LOC)
- **File:** `Sources/Onboarding/OnboardingWizardView.swift`
- **Lines:** 1-884
- **Description:** Multi-step wizard with QR scanning, manual connection, photo picker, and pairing logic all in one view.
- **Recommendation:** Extract per-step views: `OnboardingWelcomeStep`, `OnboardingConnectStep`, `OnboardingAuthStep`.

#### H4. Heavy UserDefaults coupling (no abstraction layer)
- **Files:** `NodeAppModel.swift`, `GatewayConnectionController.swift`, `SettingsTab.swift`, `GatewaySettingsStore.swift`, `RootCanvas.swift`
- **Description:** `UserDefaults.standard` is accessed directly throughout the codebase (~70+ direct reads/writes with raw string keys). There is no typed key registry or wrapper, so:
  - Key typos compile silently
  - Default values are duplicated (e.g., `"camera.enabled"` checked with fallback `true` in two places)
  - Testing requires the `withUserDefaults` helper which mutates the shared `UserDefaults.standard`
- **Recommendation:** Create a `Settings` enum with typed keys (similar to `VoiceWakePreferences`) and use dependency injection for `UserDefaults`.

#### H5. Significant test coverage gaps for critical paths
- **Description:** Several critical modules have zero test coverage. See the Test Coverage Gap Analysis table below.
- **Impact:** Changes to gateway connection lifecycle, background task management, voice/talk coordination, and canvas interaction cannot be regression-tested.

---

### MEDIUM

#### M1. Inconsistent module boundary patterns
- **Description:** Some modules use proper protocol-based DI (camera, screen recording, location, device status, photos, contacts, calendar, reminders, motion, watch messaging via `NodeServiceProtocols.swift`), while others use concrete types directly:
  - `VoiceWakeManager` and `TalkModeManager` are concrete, not protocol-backed
  - `GatewayHealthMonitor` is concrete (but has testable init with sleep injection)
  - `ScreenController` is concrete with no protocol
  - `NotificationCentering` protocol exists but is ad hoc (not in `NodeServiceProtocols.swift`)
- **Recommendation:** Add protocols for `VoiceWakeServicing`, `TalkModeServicing`, `ScreenControlling` to enable test doubles.

#### M2. Closure-based wiring instead of protocol conformance
- **Files:** `NodeAppModel.swift:178-216`, `ScreenController.swift:14-18`
- **Description:** `ScreenController.onDeepLink` and `ScreenController.onA2UIAction` are closure properties rather than delegate protocols. Similarly, `VoiceWakeManager.configure(onCommand:)` uses a closure. This makes the dependency graph harder to trace.
- **Recommendation:** Consider delegate protocols for clearer contracts, or at minimum document the callback contracts.

#### M3. OpenClawApp.swift mixes concerns (541 LOC)
- **File:** `Sources/OpenClawApp.swift`
- **Lines:** 1-541
- **Description:** Contains three distinct concerns in one file:
  1. `OpenClawAppDelegate` (push notifications, background tasks)
  2. `WatchPromptNotificationBridge` (notification category management, 200+ LOC)
  3. `OpenClawApp` (SwiftUI app entry point)
- **Recommendation:** Extract `WatchPromptNotificationBridge` to its own file.

#### M4. GatewayDiagnostics embedded in GatewaySettingsStore file
- **File:** `Sources/Gateway/GatewaySettingsStore.swift:352-448`
- **Description:** `GatewayDiagnostics` enum (file-based logging) is defined at the bottom of `GatewaySettingsStore.swift` with no relation to settings storage.
- **Recommendation:** Move to its own file `Gateway/GatewayDiagnostics.swift`.

#### M5. Duplicate code patterns in invoke handlers
- **File:** `Sources/Model/NodeAppModel.swift:1213-1358`
- **Description:** Every `handleXxxInvoke` method follows the same pattern: decode params -> call service -> encode payload -> return response. The 12 invoke handlers repeat this boilerplate with minor variations. The `default:` case error response is duplicated 9 times verbatim.
- **Recommendation:** Create a generic `invokeServiceMethod<P: Decodable, R: Encodable>` helper that handles the decode-call-encode-response cycle.

#### M6. No formal error domain or error catalog
- **Description:** Errors are constructed ad hoc using `NSError(domain:code:userInfo:)` with inconsistent domains ("Screen", "Gateway", "Camera", "NodeAppModel", "GatewayHealthMonitor", "VoiceWake") and magic number codes. Only `CameraController.CameraError` uses a proper Swift error enum.
- **Recommendation:** Define a unified `OpenClawIOSError` enum with cases for each domain, or at minimum use consistent error domains and documented code ranges.

#### M7. Two gateway sessions managed in parallel without shared state machine
- **File:** `Sources/Model/NodeAppModel.swift:96-98`
- **Description:** `nodeGateway` and `operatorGateway` are two independent `GatewayNodeSession` instances with separate reconnect loops. Their connected states (`gatewayConnected`, `operatorConnected`) are tracked independently, but the UI only shows one "gateway status". Disconnect/reconnect of one does not coordinate with the other.
- **Recommendation:** Extract a `DualGatewaySessionManager` that manages both sessions' lifecycles as a coordinated unit.

---

### LOW

#### L1. `RootView.swift` is a trivial wrapper (7 LOC)
- **File:** `Sources/RootView.swift`
- **Description:** Contains only `struct RootView: View { var body: some View { RootCanvas() } }`. This adds an unnecessary layer of indirection.
- **Recommendation:** Remove and use `RootCanvas` directly, or document why the indirection exists.

#### L2. Access control could be tighter
- **Description:** Many types use default `internal` access where `private` or `fileprivate` would be more appropriate. For example:
  - `NodeAppModel.gatewayStatusText`, `nodeStatusText`, `operatorStatusText` are `var` (settable) from outside
  - `GatewayDiscoveryModel.gateways` is `var` (not `private(set)`)
  - `VoiceWakeManager.isEnabled`, `isListening` are publicly settable
- **Recommendation:** Prefer `private(set)` for observable properties that should only be modified internally.

#### L3. `#if DEBUG` test hooks pattern
- **Files:** `GatewayConnectionController.swift:929-989`, `VoiceWakeManager.swift:477-483`, `NodeAppModel.swift` (via `_test_` prefixed methods)
- **Description:** Test hooks are exposed via `#if DEBUG` extensions with `_test_` prefixes. While functional, this pollutes the type's API surface.
- **Recommendation:** This is a reasonable pattern for host-app tests. Consider using `@_spi(Testing)` when available in Swift 6 for cleaner separation.

#### L4. Naming inconsistency: `ThrowingContinuationSupport`
- **File:** `Sources/OpenClawApp.swift:459`
- **Description:** References `ThrowingContinuationSupport.resumeVoid` which appears to be defined in OpenClawKit. The name is verbose; a simple extension on `CheckedContinuation` would be more idiomatic.

#### L5. `GatewayTLSFingerprintProbe` uses `objc_sync_enter/exit` instead of a lock
- **File:** `Sources/Gateway/GatewayConnectionController.swift:1039-1040`
- **Description:** `objc_sync_enter(self)` / `objc_sync_exit(self)` is an Objective-C runtime synchronization primitive. Modern Swift code should use `NSLock`, `os_unfair_lock`, or `Mutex` (Swift 6).
- **Recommendation:** Replace with `NSLock` or `Mutex` for consistency with other lock usage (e.g., `NotificationInvokeLatch` uses `NSLock`).

---

## Test Coverage Gap Analysis

| Source File | LOC | Test File | Test LOC | Coverage |
|---|---|---|---|---|
| `Model/NodeAppModel.swift` | 2787 | `NodeAppModelInvokeTests.swift` | 478 | **Partial** - invoke dispatch only; no tests for reconnect, background, deep links |
| `Voice/TalkModeManager.swift` | 2153 | `TalkModeConfigParsingTests.swift` | 31 | **Minimal** - config parsing only; no PTT, speech, or playback tests |
| `Gateway/GatewayConnectionController.swift` | 1058 | `GatewayConnectionControllerTests.swift` + `GatewayConnectionSecurityTests.swift` | 226 | **Partial** - security + basic flow; no TLS probe, Bonjour resolve, or autoconnect tests |
| `Settings/SettingsTab.swift` | 1032 | `SwiftUIRenderSmokeTests.swift` (1 test) | ~8 | **Smoke only** - verifies view hierarchy builds |
| `Onboarding/OnboardingWizardView.swift` | 884 | None | 0 | **None** |
| `OpenClawApp.swift` | 541 | None | 0 | **None** - WatchPromptNotificationBridge untested |
| `Voice/VoiceWakeManager.swift` | 483 | `VoiceWakeManagerStateTests.swift` + `VoiceWakeManagerExtractCommandTests.swift` | 144 | **Good** - state transitions + command extraction |
| `Gateway/GatewaySettingsStore.swift` | 448 | `GatewaySettingsStoreTests.swift` | 197 | **Good** |
| `RootCanvas.swift` | 429 | `SwiftUIRenderSmokeTests.swift` | ~8 | **Smoke only** |
| `Onboarding/GatewayOnboardingView.swift` | 371 | None | 0 | **None** |
| `Screen/ScreenRecordService.swift` | 350 | `ScreenRecordServiceTests.swift` | 32 | **Minimal** |
| `Camera/CameraController.swift` | 339 | `CameraControllerClampTests.swift` + `CameraControllerErrorTests.swift` | 38 | **Minimal** - clamp/error only; no capture flow tests |
| `Services/WatchMessagingService.swift` | 284 | None (mock in NodeAppModelInvokeTests) | 0 | **None** |
| `Screen/ScreenController.swift` | 267 | `ScreenControllerTests.swift` | 87 | **Good** |
| `Contacts/ContactsService.swift` | 210 | None | 0 | **None** |
| `Screen/ScreenWebView.swift` | 193 | None | 0 | **None** |
| `Gateway/GatewayDiscoveryModel.swift` | 181 | `GatewayDiscoveryModelTests.swift` | 22 | **Minimal** |
| `Location/LocationService.swift` | 177 | None | 0 | **None** |
| `Media/PhotoLibraryService.swift` | 164 | None | 0 | **None** |
| `Chat/IOSGatewayChatTransport.swift` | 142 | `IOSGatewayChatTransportTests.swift` | 30 | **Minimal** |
| `Calendar/CalendarService.swift` | 135 | None | 0 | **None** |
| `Reminders/RemindersService.swift` | 133 | None | 0 | **None** |
| `Motion/MotionService.swift` | 100 | None | 0 | **None** |
| `Model/NodeAppModel+WatchNotifyNormalization.swift` | 103 | `VoiceWakeGatewaySyncTests.swift` (partial) | 22 | **Minimal** |
| `Model/NodeAppModel+Canvas.swift` | 59 | None | 0 | **None** |
| `Gateway/GatewayHealthMonitor.swift` | 85 | None | 0 | **None** |
| `Gateway/KeychainStore.swift` | 48 | `KeychainStoreTests.swift` | 22 | **Minimal** |
| `Onboarding/OnboardingStateStore.swift` | 52 | `OnboardingStateStoreTests.swift` | 57 | **Good** |
| `Gateway/GatewayConnectionIssue.swift` | 71 | `GatewayConnectionIssueTests.swift` | 33 | **Good** |
| `SessionKey.swift` | 23 | Tested via `NodeAppModelInvokeTests` | - | **Good** (indirectly) |
| `Settings/SettingsNetworkingHelpers.swift` | 40 | `SettingsNetworkingHelpersTests.swift` | 50 | **Good** |
| `Voice/VoiceWakePreferences.swift` | 44 | `VoiceWakePreferencesTests.swift` | 38 | **Good** |
| `Device/NodeDisplayName.swift` | 48 | Tested via GatewayConnectionControllerTests | - | **Partial** |

### Coverage Summary
- **63 source files**, **25 test files** (24 test + 1 helper)
- **17 source modules with zero test coverage** (service implementations, onboarding views, several gateway files)
- **Test LOC ratio:** 1,884 / 16,244 = **11.6%** (low for a production app)
- **Test framework:** Swift Testing (`@Test`, `#expect`) -- modern and correct
- **Test patterns:** Good use of mocks (MockWatchMessagingService), `withUserDefaults` helper for isolation, `_test_` hooks for internal access. SwiftUI render smoke tests validate view hierarchy construction.

### Critical Untested Paths
1. **Gateway reconnect state machine** - the most complex logic in the app (background lease, pairing pause, backoff) has zero tests
2. **Background lifecycle management** - grace periods, suppression, wake handling untested
3. **Onboarding flow** - 1,255 LOC across 3 files with zero tests
4. **Push notification handling** - APNs registration, silent push, background refresh untested
5. **TalkModeManager** - 2,153 LOC with only 31 LOC of config parsing tests

---

## Dependency Injection Assessment

### Well-Injected (protocol-based, testable)
All services in `NodeServiceProtocols.swift` are protocol-based with default production implementations:
- `CameraServicing` -> `CameraController`
- `ScreenRecordingServicing` -> `ScreenRecordService`
- `LocationServicing` -> `LocationService`
- `DeviceStatusServicing` -> `DeviceStatusService`
- `PhotosServicing` -> `PhotoLibraryService`
- `ContactsServicing` -> `ContactsService`
- `CalendarServicing` -> `CalendarService`
- `RemindersServicing` -> `RemindersService`
- `MotionServicing` -> `MotionService`
- `WatchMessagingServicing` -> `WatchMessagingService`
- `NotificationCentering` -> `LiveNotificationCenter`

`NodeAppModel.init()` accepts all of these via parameters with defaults -- excellent DI pattern.

### Not Injected (hardcoded dependencies)
- `GatewaySettingsStore` - static enum, not injectable. Tests must use real `UserDefaults`/Keychain.
- `GatewayDiagnostics` - static enum with file I/O, not injectable.
- `GatewayDiscoveryModel` - concrete class created inside `GatewayConnectionController.init`.
- `GatewayHealthMonitor` - created internally by `NodeAppModel` (but has testable init).
- `VoiceWakeManager` - created internally, injected into SwiftUI environment.
- `TalkModeManager` - injected via `NodeAppModel.init` parameter (good).
- `ScreenController` - injected via `NodeAppModel.init` parameter (good).

---

## Data Flow Patterns

### Observation Framework Usage
The app uses Swift's `Observation` framework (`@Observable`) consistently:
- `NodeAppModel`, `GatewayConnectionController`, `GatewayDiscoveryModel`, `VoiceWakeManager`, `TalkModeManager`, `ScreenController` are all `@Observable`.
- SwiftUI views access them via `@Environment(Type.self)`.
- No legacy `ObservableObject` / `@StateObject` patterns found -- this is correct per CLAUDE.md guidance.

### Environment Propagation
```
OpenClawApp
  |-- @State NodeAppModel           -> .environment(appModel)
  |-- @State GatewayConnectionController -> .environment(gatewayController)
  |-- appModel.voiceWake (VoiceWakeManager) -> .environment(appModel.voiceWake)
```
This is clean, though `voiceWake` being both a property of `NodeAppModel` AND injected separately into the environment creates a potential consistency issue if they ever diverge.

---

## Architectural Strengths

1. **Strong protocol-based DI for services** - `NodeServiceProtocols.swift` defines clean interfaces for all device capabilities, enabling easy mocking in tests.
2. **Modern Swift 6 / Observation adoption** - No legacy `ObservableObject` patterns; strict concurrency enabled.
3. **NodeCapabilityRouter** - Clean command-routing pattern that decouples command registration from handling.
4. **Dual gateway session architecture** - Separating node (device capabilities) from operator (chat/config) connections is architecturally sound.
5. **GatewayConnectConfig** - Single source of truth struct for connection parameters.
6. **Consistent input validation** - Nearly every string input is trimmed and empty-checked.
7. **Keychain-based credential storage** - Sensitive data (tokens, passwords) stored in Keychain, not UserDefaults.
8. **`CameraController` uses actor isolation** - Correct concurrency pattern for hardware resource.

---

## Recommended Refactoring Priority

1. **[CRITICAL]** Split `NodeAppModel` into 5-6 focused types (highest ROI for testability)
2. **[CRITICAL]** Split `TalkModeManager` into 3-4 focused types
3. **[HIGH]** Add tests for gateway reconnect state machine
4. **[HIGH]** Add tests for background lifecycle management
5. **[HIGH]** Extract `SettingsTab` into section views
6. **[MEDIUM]** Create typed `UserDefaults` key registry
7. **[MEDIUM]** Unify error handling with a proper error catalog
8. **[MEDIUM]** Extract duplicate invoke handler boilerplate
