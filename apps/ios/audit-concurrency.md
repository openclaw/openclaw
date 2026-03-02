# Swift 6 Concurrency Audit: OpenClaw iOS App

**Scope:** `apps/ios/Sources/` (63 files, ~15K LOC)
**Date:** 2026-03-02
**Auditor:** Concurrency Auditor Agent

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Files audited | 63 |
| `@MainActor` classes | 8 |
| `actor` types | 1 (`CameraController`) |
| `@unchecked Sendable` types | 9 |
| `@preconcurrency` imports | 2 (`UserNotifications`, `WatchConnectivity`) |
| `@preconcurrency` conformances | 2 (`UNUserNotificationCenterDelegate`, `NetServiceDelegate`) |
| `nonisolated(unsafe)` usages | 1 |
| `NSLock` usages | 6 |
| `DispatchQueue` usages | 7 |
| `objc_sync_enter/exit` usages | 1 |
| `CheckedContinuation` usages | ~25 |
| `@Observable` (Observation framework) types | 6 |
| `ObservableObject` types | 0 |

### Overall Assessment

The codebase is in **good shape for Swift 6 strict concurrency**. The major model types use `@MainActor` + `@Observable` (Observation framework), there are zero `ObservableObject` usages, and the actor model is applied consistently. There are no `@Sendable` annotations missing on closure parameters in any obvious way, and the use of `@unchecked Sendable` is confined to genuine low-level synchronization wrappers. However, there are several areas that warrant attention.

---

## Critical Findings

### C-1: `GatewayTLSFingerprintProbe` uses `objc_sync_enter` + `@unchecked Sendable` with unsynchronized `didFinish` read

**File:** `Gateway/GatewayConnectionController.swift:992-1058`
**Severity:** Critical (potential data race)

```swift
private final class GatewayTLSFingerprintProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
    private var didFinish = false   // line 996
    private var session: URLSession? // line 997
    private var task: URLSessionWebSocketTask? // line 998
    ...
    private func finish(_ fingerprint: String?) {
        objc_sync_enter(self)       // line 1039
        defer { objc_sync_exit(self) }
        guard !self.didFinish else { return }
        ...
    }
}
```

**Issue:** The `start()` method (line 1006) reads and writes `self.session` and `self.task` without any lock. The `DispatchQueue.global().asyncAfter` timeout on line 1016 calls `finish()` from a background queue while `start()` sets properties on the caller's thread. Additionally, `URLSession` delegate callbacks arrive on an arbitrary delegate queue (nil was passed for `delegateQueue`), which means `urlSession(_:didReceive:completionHandler:)` and `finish()` can race.

**Recommendation:** Replace `objc_sync_enter/exit` with `NSLock` or `OSAllocatedUnfairLock`. Ensure all mutable state (`didFinish`, `session`, `task`) is accessed under the lock. Better yet, convert to an `actor` since this is a short-lived async operation. Alternatively, use `OSAllocatedUnfairLock<State>` wrapping a struct.

---

### C-2: `PhotoCaptureDelegate` and `MovieFileDelegate` lack synchronization on `didResume`

**File:** `Camera/CameraController.swift:260-339`
**Severity:** Critical (potential double continuation resume)

```swift
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let continuation: CheckedContinuation<Data, Error>
    private var didResume = false  // NOT thread-safe

    func photoOutput(...) {
        guard !self.didResume else { return } // line 273
        self.didResume = true
        ...
    }
    func photoOutput(...didFinishCaptureFor...) {
        guard let error else { return }
        guard !self.didResume else { return } // line 303
        self.didResume = true
        ...
    }
}
```

**Issue:** `AVCapturePhotoCaptureDelegate` callbacks can arrive on different queues. The `didResume` flag is a plain `Bool` with no synchronization. If `didFinishProcessingPhoto` and `didFinishCaptureFor` are called concurrently (possible under certain error conditions), both could read `didResume` as `false` and resume the continuation twice, which is a fatal crash in debug builds and undefined behavior in release.

**Recommendation:** Protect `didResume` with `OSAllocatedUnfairLock<Bool>` or `NSLock`. The same issue applies to `MovieFileDelegate` on line 309.

---

### C-3: `GatewayDiagnostics.logWritesSinceCheck` is `nonisolated(unsafe)` static var

**File:** `Gateway/GatewaySettingsStore.swift:358`
**Severity:** Critical (data race)

```swift
nonisolated(unsafe) private static var logWritesSinceCheck = 0
```

**Issue:** This counter is read and written inside `queue.async {}` blocks on `GatewayDiagnostics.queue`, but `nonisolated(unsafe)` tells the compiler to skip checking. The access is actually serialized by the private `DispatchQueue`, so it is functionally safe -- however, `nonisolated(unsafe)` is a red flag for Swift 6 audits because it permanently suppresses the compiler's data-race safety checks.

**Recommendation:** Replace with proper synchronization visible to the compiler. Either:
1. Make it a local variable inside the `DispatchQueue` closure scope, or
2. Wrap in `OSAllocatedUnfairLock<Int>` or a dedicated `actor`, or
3. Since all accesses are on `GatewayDiagnostics.queue`, convert to a `@Sendable`-safe pattern that doesn't require `nonisolated(unsafe)`.

---

## High Findings

### H-1: `ScreenRecordService` is `@unchecked Sendable` but holds no state -- its inner `CaptureState` synchronizes via NSLock but `UncheckedSendableBox` silences Sendable checks

**File:** `Screen/ScreenRecordService.swift:4-11`
**Severity:** High

```swift
final class ScreenRecordService: @unchecked Sendable {
    private struct UncheckedSendableBox<T>: @unchecked Sendable {
        let value: T
    }
```

**Issue:** `UncheckedSendableBox` wraps **any** `T` (including non-Sendable types like `CMSampleBuffer`) and marks it `@unchecked Sendable`. This is used to pass `CMSampleBuffer` across threads in the capture handler. While `CMSampleBuffer` is effectively thread-safe for read-only access, this pattern silences the compiler completely and could mask future issues if the box is used for other types.

**Recommendation:** Use `nonisolated(unsafe) let value: T` instead if on Swift 6.2+, or document the specific thread-safety invariant. Consider constraining `T: Sendable` on the generic and handling `CMSampleBuffer` separately with a targeted unsafe annotation.

### H-2: `WatchMessagingService` is `@unchecked Sendable` with mutable `replyHandler` protected only by NSLock

**File:** `Services/WatchMessagingService.swift:23-28`
**Severity:** High

```swift
final class WatchMessagingService: NSObject, WatchMessagingServicing, @unchecked Sendable {
    private let replyHandlerLock = NSLock()
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
```

**Issue:** While the `replyHandler` is properly protected by `NSLock`, the `session` property (`WCSession?`) is accessed from both the main thread (via delegate callbacks forwarded with `@preconcurrency`) and potentially from WatchConnectivity's internal threads. The `WCSession` properties like `isPaired`, `isWatchAppInstalled`, `isReachable` are read in `status(for:)` without synchronization and could race with delegate callbacks.

**Recommendation:** Convert to an `actor` or ensure all `WCSession` property reads happen on a specific isolation context. The lock properly protects `replyHandler`, so this is a moderate risk.

### H-3: `LocationService` stores `CheckedContinuation` as instance vars without synchronization between `nonisolated` delegate callbacks and `@MainActor` methods

**File:** `Location/LocationService.swift:13-14, 136-176`
**Severity:** High

```swift
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate, LocationServiceCommon {
    private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    private var locationContinuation: CheckedContinuation<CLLocation, Swift.Error>?
```

The delegate methods are marked `nonisolated`:
```swift
nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    Task { @MainActor in
        if let cont = self.authContinuation { ... }
    }
}
```

**Issue:** The `nonisolated` delegate methods create `Task { @MainActor in }` to hop back to the main actor before accessing continuations. This is the correct pattern. However, there is a subtle race: if two delegate callbacks arrive in rapid succession, both could queue `@MainActor` tasks, and the second one would find the continuation already `nil`. This is handled (the `if let` guards), but the pattern is fragile. More importantly, `CLLocationManager` requires its delegate methods to be called on the queue it was created on. Since the class is `@MainActor`, the manager is created on main, and iOS should deliver delegate callbacks on main -- making the `nonisolated` annotation somewhat misleading.

**Recommendation:** Since `CLLocationManager` delivers callbacks on the thread/queue of the delegate's assigned queue (main in this case), the `nonisolated` annotation is technically unnecessary and may confuse future maintainers. Consider removing `nonisolated` and letting `@MainActor` inheritance apply. This would also let the compiler verify the continuation access is safe.

### H-4: `LiveNotificationCenter` is `@unchecked Sendable` wrapping a non-Sendable `UNUserNotificationCenter`

**File:** `Services/NotificationService.swift:18-58`
**Severity:** High

```swift
struct LiveNotificationCenter: NotificationCentering, @unchecked Sendable {
    private let center: UNUserNotificationCenter
```

**Issue:** `UNUserNotificationCenter` is not `Sendable`. Wrapping it in `@unchecked Sendable` silences the compiler. In practice, `UNUserNotificationCenter.current()` returns a singleton that is thread-safe, so this is functionally fine -- but the compiler cannot verify this.

**Recommendation:** This is acceptable given `UNUserNotificationCenter.current()` is a thread-safe singleton. Document the invariant with a comment explaining why `@unchecked Sendable` is safe here. Alternatively, access the center via `UNUserNotificationCenter.current()` each time instead of storing it.

### H-5: `NetworkStatusService` is `@unchecked Sendable` but has no mutable state

**File:** `Device/NetworkStatusService.swift:5`
**Severity:** High (misleading annotation)

```swift
final class NetworkStatusService: @unchecked Sendable {
```

**Issue:** `NetworkStatusService` has no stored properties at all. It creates `NWPathMonitor` locally in each method call. The `@unchecked Sendable` is unnecessary because a stateless final class is inherently `Sendable`.

**Recommendation:** Remove `@unchecked` -- just conform to `Sendable` directly. The class has no mutable state and is `final`, so it qualifies for automatic Sendable conformance.

---

## Medium Findings

### M-1: `TalkModeManager` `pttCompletion` continuation stored as instance var could leak

**File:** `Voice/TalkModeManager.swift:43`
**Severity:** Medium

```swift
private var pttCompletion: CheckedContinuation<OpenClawTalkPTTStopPayload, Never>?
```

**Issue:** If `pttCompletion` is set but the manager is deinitialized or the PTT session is interrupted without resuming it, the continuation will leak. `CheckedContinuation` logs a warning in debug builds when it is never resumed, and in production the caller will hang indefinitely.

**Recommendation:** Add a `deinit` or cleanup path that resumes `pttCompletion` with a default/error value. Also verify that all code paths that set `pttCompletion` eventually resume it (including error paths, cancellation, and mode changes).

### M-2: Heavy use of `Task { @MainActor in }` hops in code that is already `@MainActor`

**Files:** Multiple (OpenClawApp.swift:30-47, NodeAppModel.swift:179-207, etc.)
**Severity:** Medium (performance/clarity)

```swift
// In OpenClawAppDelegate which is already @MainActor:
Task { @MainActor in
    model.updateAPNsDeviceToken(token)
}
```

**Issue:** When code is already on `@MainActor`, creating `Task { @MainActor in }` is redundant in terms of isolation but does defer execution to the next event loop tick. If the intent is immediate execution, this is a performance anti-pattern. If the intent is deferral, it should be documented.

**Recommendation:** Where immediate execution is intended, call the method directly. Where deferral is intentional, add a comment explaining why. In Swift 6.2 with `nonisolated(nonsending)` defaults, these patterns will behave differently.

### M-3: `GatewayDiscoveryModel` browser callbacks use closures that capture `self` without explicit `@Sendable`

**File:** `Gateway/GatewayDiscoveryModel.swift:60-96`
**Severity:** Medium

```swift
let browser = GatewayDiscoveryBrowserSupport.makeBrowser(
    ...
    onState: { [weak self] state in
        guard let self else { return }
        self.statesByDomain[domain] = state  // MainActor state access
    },
    onResults: { [weak self] results in
        guard let self else { return }
        self.gatewaysByDomain[domain] = results.compactMap { ... }
```

**Issue:** These closures capture `self` (a `@MainActor` `@Observable` class) and mutate its state. If `GatewayDiscoveryBrowserSupport.makeBrowser` dispatches these callbacks on a background queue (which NWBrowser does by default), this would be a main-actor isolation violation. The callbacks access `@MainActor`-isolated properties without explicitly hopping to the main actor.

**Recommendation:** Verify that `GatewayDiscoveryBrowserSupport.makeBrowser` dispatches callbacks on the main queue. If not, wrap the callback bodies in `Task { @MainActor in ... }` or `await MainActor.run { ... }`. This is a potential data race if callbacks arrive off-main.

### M-4: `withObservationTracking` + `onChange` pattern in `GatewayConnectionController.observeDiscovery()` could miss updates

**File:** `Gateway/GatewayConnectionController.swift:293-305`
**Severity:** Medium

```swift
private func observeDiscovery() {
    withObservationTracking {
        _ = self.discovery.gateways
        _ = self.discovery.statusText
        _ = self.discovery.debugLog
    } onChange: { [weak self] in
        Task { @MainActor in
            guard let self else { return }
            self.updateFromDiscovery()
            self.observeDiscovery()  // re-register
        }
    }
}
```

**Issue:** The `onChange` handler in `withObservationTracking` fires at most once per registration. The recursive re-registration inside `Task { @MainActor in }` means there is a window between when the `onChange` fires and when the new tracking is registered where changes could be missed. In practice, the `Task` hop is fast, but under heavy load or if the main actor queue is busy, rapid changes to `discovery.gateways` could be dropped.

**Recommendation:** This is a known limitation of `withObservationTracking` outside SwiftUI. Consider using `AsyncStream` or `Combine` publisher from the discovery model instead, which provides continuous observation without re-registration gaps.

### M-5: `GatewayServiceResolver` does not protect `didFinish` flag with a lock

**File:** `Gateway/GatewayServiceResolver.swift:9, 41-47`
**Severity:** Medium

```swift
final class GatewayServiceResolver: NSObject, NetServiceDelegate {
    private var didFinish = false

    private func finish(result: ...) {
        guard !self.didFinish else { return }
        self.didFinish = true
        ...
    }
}
```

**Issue:** `NetServiceDelegate` callbacks can theoretically arrive on multiple threads (depending on how the service is scheduled). The `didFinish` flag is not synchronized. If `netServiceDidResolveAddress` and `netService(_:didNotResolve:)` are called concurrently, `finish` could be called twice.

**Recommendation:** Add `NSLock` protection or use `OSAllocatedUnfairLock<Bool>` for `didFinish`. Alternatively, ensure the service is always scheduled on the main run loop (which `BonjourServiceResolverSupport.start` may already do).

### M-6: `ContactsService`, `CalendarService`, `RemindersService`, `MotionService`, `PhotoLibraryService` conform to `Sendable` protocols but are plain classes without actor isolation

**Files:** Various service files
**Severity:** Medium

```swift
final class ContactsService: ContactsServicing { ... }
// ContactsServicing: Sendable
```

**Issue:** These classes have no mutable stored properties and are `final`, which technically makes them safe to mark `Sendable`. However, they don't explicitly declare `Sendable` conformance -- they inherit it through their protocol conformances (`ContactsServicing: Sendable`). The Swift 6 compiler will flag this because a `final class` without explicit `Sendable` or `@unchecked Sendable` conformance cannot implicitly satisfy `Sendable` requirements from protocols unless it is provably safe (no mutable state).

**Recommendation:** Since these classes are stateless and `final`, add explicit `: Sendable` conformance or verify they compile cleanly under strict concurrency.

---

## Low Findings

### L-1: `@preconcurrency import UserNotifications` and `@preconcurrency import WatchConnectivity` suppress Sendable warnings

**Files:** `OpenClawApp.swift:7`, `Services/WatchMessagingService.swift:4`
**Severity:** Low

**Issue:** `@preconcurrency` imports suppress sendability diagnostics for types from those modules. As Apple updates these frameworks for Sendable conformance in newer SDKs, the `@preconcurrency` should be removed to benefit from the compiler's checks.

**Recommendation:** Periodically check if these frameworks have been updated with Sendable annotations in newer Xcode versions and remove `@preconcurrency` when possible.

### L-2: `VoiceWakeManager.makeRecognitionResultHandler()` returns `@Sendable` closure that captures `[weak self]` correctly

**File:** `Voice/VoiceWakeManager.swift:301-313`
**Severity:** Low (informational -- this is well done)

The recognition result handler correctly captures `[weak self]` and hops to `@MainActor` before accessing any state. This is a good pattern.

### L-3: `CameraController` is an `actor` -- exemplary usage

**File:** `Camera/CameraController.swift:5`
**Severity:** Low (informational -- this is well done)

`CameraController` is the only `actor` in the codebase. It properly uses `nonisolated static` for pure functions and `async` for all state-mutating operations. This is a model for how other services could be structured.

### L-4: Several `Task { }` in `@MainActor` context don't explicitly annotate `@MainActor`

**Files:** Multiple
**Severity:** Low

```swift
// Inside @MainActor class:
Task { [weak self] in
    guard let self else { return }
    _ = await self.connectDiscoveredGateway(target)
}
```

**Issue:** In Swift 6.0, an unstructured `Task { }` created from `@MainActor` context inherits the actor context. However, in Swift 6.2 with `nonisolated(nonsending)` defaults, this behavior may change. Explicitly annotating `Task { @MainActor in }` makes the intent clear and forward-compatible.

**Recommendation:** Add explicit `@MainActor` annotation to `Task { }` blocks in `@MainActor` types where main-actor isolation is required.

### L-5: Consider migrating `NSLock` to `OSAllocatedUnfairLock` for better performance

**Files:** Multiple (6 usages)
**Severity:** Low

`OSAllocatedUnfairLock` (available since iOS 16) is faster than `NSLock` for short critical sections. The existing `NSLock` usages in `AudioBufferQueue`, `NotificationInvokeLatch`, `CaptureState`, etc. are all protecting brief property accesses and would benefit from the switch.

**Recommendation:** Migrate `NSLock` to `OSAllocatedUnfairLock` where deployment target allows (iOS 16+). `TCPProbe.swift` already uses `OSAllocatedUnfairLock` -- apply the same pattern to other files.

### L-6: `NodeAppModel` is very large (~1500+ lines) which makes concurrency reasoning difficult

**File:** `Model/NodeAppModel.swift`
**Severity:** Low (maintainability)

**Issue:** The large file size with many Task/async operations, multiple gateway sessions, and deeply nested closures makes it harder to reason about concurrency invariants. All state is `@MainActor` which is safe, but the complexity makes it harder to verify no accidental non-isolated access exists.

**Recommendation:** Consider splitting into smaller focused files (already noted with `NodeAppModel+Canvas.swift` and `NodeAppModel+WatchNotifyNormalization.swift` extensions). Further decomposition would improve auditability.

---

## Positive Patterns Found

1. **Consistent `@MainActor` + `@Observable` usage**: All major model types (`NodeAppModel`, `GatewayConnectionController`, `GatewayDiscoveryModel`, `TalkModeManager`, `VoiceWakeManager`, `ScreenController`) use the Observation framework with `@MainActor` isolation. Zero `ObservableObject` usages.

2. **Zero `@Sendable` protocol conformance issues**: All service protocols (`CameraServicing`, `LocationServicing`, `DeviceStatusServicing`, etc.) correctly require `Sendable`.

3. **`CameraController` as `actor`**: Properly models concurrent camera access.

4. **`@Sendable` closures in callback APIs**: Callback closures (e.g., `onCommand` in `VoiceWakeManager`, `replyHandler` in `WatchMessagingService`) are properly annotated `@Sendable`.

5. **`CheckedContinuation` usage**: All continuation usages properly handle the single-resume invariant with `didResume`/`finished` flags (though some lack synchronization -- see C-2 and M-5).

6. **No `DispatchQueue.main.async` for UI updates**: All UI-related state mutations go through `@MainActor` or `Task { @MainActor in }`, not legacy GCD patterns.

7. **`ThrowingContinuationSupport.resumeVoid`**: Custom helper for void continuations reduces boilerplate and potential mistakes.

---

## Swift 6.2 / iOS 26 Forward-Compatibility Notes

1. **`nonisolated(nonsending)` default**: Several `nonisolated` functions and closures may need `@concurrent` annotation if they are intended to run off the caller's actor. Review all `nonisolated` methods.

2. **Default `@MainActor` isolation**: If the project opts into Swift 6.2's `MainActorByDefault`, most explicit `@MainActor` annotations become redundant. The current architecture is well-positioned for this.

3. **`@preconcurrency` removal**: As Apple frameworks adopt Sendable, remove `@preconcurrency` imports for `UserNotifications` and `WatchConnectivity`.

4. **`sending` parameter keyword**: New `sending` keyword in Swift 6.2 may replace some `@Sendable` closure annotations for parameters that are consumed (not stored).
