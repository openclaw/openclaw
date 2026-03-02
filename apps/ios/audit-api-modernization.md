# iOS API Modernization Audit Report

**Date:** 2026-03-02
**Auditor:** API Modernization Expert (Claude Opus 4.6)
**Scope:** All Swift source files in `apps/ios/Sources/`, `apps/ios/WatchExtension/Sources/`, and `apps/ios/ShareExtension/`
**Deployment Target:** iOS 18.0 / watchOS 11.0
**Swift Version:** 6.0 (strict concurrency: complete)
**Xcode Version:** 16.0

---

## Executive Summary

The OpenClaw iOS codebase is well-maintained and has already adopted many modern Swift and iOS patterns. The Observation framework (`@Observable`, `@Bindable`, `@Environment(ModelType.self)`) is used consistently throughout. `NavigationStack` is used instead of the deprecated `NavigationView`. Swift 6 strict concurrency is enabled project-wide.

However, there are several areas where deprecated APIs remain in use, unnecessary availability checks exist (dead code given iOS 18.0 deployment target), and legacy callback-based APIs are wrapped in continuations where native async alternatives are available.

### Summary by Severity

| Severity | Count | Description |
|----------|-------|-------------|
| Critical | 1     | Deprecated `NetService` usage (removed in future SDKs) |
| High     | 4     | Dead availability-check code, legacy callback wrapping |
| Medium   | 8     | Callback APIs with async alternatives, legacy patterns |
| Low      | 6     | Minor modernization opportunities, style improvements |

---

## Critical Findings

### C-1: `NetService` Usage (Deprecated Since iOS 16)

**Files:**
- `apps/ios/Sources/Gateway/GatewayServiceResolver.swift` (entire file)
- `apps/ios/Sources/Gateway/GatewayConnectionController.swift` (lines ~560-657)

**Current Code:**
`GatewayServiceResolver` is built entirely on `NetService` and `NetServiceDelegate`, which have been deprecated since iOS 16. `GatewayConnectionController` uses `NetService` for Bonjour resolution in `resolveBonjourServiceToHostPort`.

**Risk:** Apple may remove `NetService` entirely in a future SDK. The app already uses `NWBrowser` (Network framework) for discovery in `GatewayDiscoveryModel.swift`, creating an inconsistency where discovery uses the modern API but resolution falls back to the deprecated one.

**Recommended Replacement:** Migrate to `NWConnection` for TCP connection establishment and use the endpoint information from `NWBrowser` results directly, eliminating the need for a separate `NetService`-based resolver. The `NWBrowser.Result` already provides `NWEndpoint` values that can be used with `NWConnection` without resolution.

---

## High Findings

### H-1: Unnecessary `#available(iOS 15.0, *)` Check

**File:** `apps/ios/Sources/OpenClawApp.swift`, line 344

**Current Code:**
```swift
if #available(iOS 15.0, *) { ... }
```

**Issue:** The deployment target is iOS 18.0, so this check is always true. The code inside the `#available` block executes unconditionally, and the compiler may warn about this.

**Recommended Fix:** Remove the `#available` check and keep only the body.

### H-2: Dead `AVAssetExportSession` Fallback Code

**File:** `apps/ios/Sources/Camera/CameraController.swift`, lines ~222-249

**Current Code:**
```swift
if #available(iOS 18.0, tvOS 18.0, visionOS 2.0, *) {
    try await exportSession.export(to: fileURL, as: .mp4)
} else {
    exportSession.outputURL = fileURL
    exportSession.outputFileType = .mp4
    await exportSession.export()
    // ...legacy error check...
}
```

**Issue:** The `else` branch is dead code since the deployment target is iOS 18.0. The `#available` check is always true.

**Recommended Fix:** Remove the `#available` check and the `else` branch entirely. Use only the modern `export(to:as:)` API.

### H-3: Callback-Based `UNUserNotificationCenter` APIs Wrapped in Continuations

**File:** `apps/ios/Sources/OpenClawApp.swift`, lines ~429-462

**Current Code:**
```swift
let settings = await withCheckedContinuation { cont in
    center.getNotificationSettings { settings in
        cont.resume(returning: settings)
    }
}
```

**Issue:** `UNUserNotificationCenter` has had native async APIs since iOS 15:
- `center.notificationSettings()` (replaces `getNotificationSettings`)
- `center.notificationCategories()` (replaces `getNotificationCategories`)
- `try await center.add(request)` (replaces `add(_:completionHandler:)`)

The Watch app (`WatchInboxStore.swift`, line 161) already correctly uses the modern async pattern: `await center.notificationSettings()`.

**Recommended Fix:** Replace all `withCheckedContinuation` wrappers around `UNUserNotificationCenter` with their native async equivalents.

### H-4: `NSItemProvider.loadItem` Callback Pattern in Share Extension

**File:** `apps/ios/ShareExtension/ShareViewController.swift`, lines ~501-547

**Current Code:**
```swift
await withCheckedContinuation { continuation in
    provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
        // ...
        continuation.resume(returning: ...)
    }
}
```

**Issue:** `NSItemProvider` has had modern async alternatives since iOS 16:
- `try await provider.loadItem(forTypeIdentifier:)` for basic loading
- `try await provider.loadDataRepresentation(for:)` with `UTType` parameter
- `try await provider.loadFileRepresentation(for:)`

Three separate methods (`loadURLValue`, `loadTextValue`, `loadDataValue`) all wrap callbacks in continuations.

**Recommended Fix:** Adopt the modern `NSItemProvider` async APIs, using `UTType` parameters instead of string identifiers where possible.

---

## Medium Findings

### M-1: `CLLocationManager` Delegate Pattern vs Modern `CLLocationUpdate` API

**File:** `apps/ios/Sources/Location/LocationService.swift` (entire file)

**Current Code:** Uses `CLLocationManagerDelegate` with:
- `startUpdatingLocation()` / `stopUpdatingLocation()`
- `startMonitoringSignificantLocationChanges()`
- `requestWhenInUseAuthorization()` / `requestAlwaysAuthorization()`
- `locationManager(_:didUpdateLocations:)` delegate callback

**Modern Alternative (iOS 17+):**
- `CLLocationUpdate.liveUpdates()` async sequence for continuous location
- `CLMonitor` for region monitoring and significant location changes
- `CLLocationManager.requestWhenInUseAuthorization()` still required for authorization, but updates are consumed via async sequences

**Impact:** The delegate pattern works but requires more boilerplate and is harder to compose with async/await code.

**Recommended Fix:** Migrate `startLocationUpdates` to use `CLLocationUpdate.liveUpdates()` and consider `CLMonitor` for significant location changes. Keep the authorization request methods as-is (no async alternative for those).

### M-2: `CMMotionActivityManager` and `CMPedometer` Callback Wrapping

**File:** `apps/ios/Sources/Motion/MotionService.swift`, lines 23-81

**Current Code:**
```swift
return try await withCheckedThrowingContinuation { continuation in
    activityManager.queryActivityStarting(from: startDate, to: endDate, to: OperationQueue.main) { activities, error in
        // ...
    }
}
```

**Issue:** CoreMotion APIs still use callbacks; there are no native async versions. However, wrapping in `withCheckedThrowingContinuation` is currently the correct approach.

**Recommended Fix:** No change needed at this time. Monitor for async CoreMotion APIs in future SDK releases.

### M-3: `EKEventStore.fetchReminders` Callback Wrapping

**File:** `apps/ios/Sources/Reminders/RemindersService.swift`, lines 20-45

**Current Code:**
```swift
return try await withCheckedThrowingContinuation { continuation in
    store.fetchReminders(matching: predicate) { reminders in
        // ...
    }
}
```

**Issue:** EventKit still uses callbacks for `fetchReminders`. The continuation wrapper is the correct approach for now.

**Recommended Fix:** No change needed. This is the standard pattern for callback-based EventKit APIs.

### M-4: `PHImageManager.requestImage` Synchronous Callback Pattern

**File:** `apps/ios/Sources/Media/PhotoLibraryService.swift`, line ~82

**Current Code:**
```swift
let options = PHImageRequestOptions()
options.isSynchronous = true
// ...
imageManager.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { image, _ in
    resultImage = image
}
```

**Issue:** Uses `isSynchronous = true` which blocks the calling thread. Modern iOS apps should prefer async image loading. Consider using `PHImageManager`'s async image loading or the newer `PHPickerViewController` patterns for user-initiated selection.

**Recommended Fix:** If this code runs on a background thread (inside an actor), the synchronous pattern is acceptable for simplicity. Consider wrapping in a continuation if thread blocking becomes an issue.

### M-5: `NotificationCenter` Observer Callback Pattern

**File:** `apps/ios/Sources/Voice/VoiceWakeManager.swift`, lines 105-113

**Current Code:**
```swift
self.userDefaultsObserver = NotificationCenter.default.addObserver(
    forName: UserDefaults.didChangeNotification,
    object: UserDefaults.standard,
    queue: .main,
    using: { [weak self] _ in
        Task { @MainActor in
            self?.handleUserDefaultsDidChange()
        }
    })
```

**Modern Alternative (iOS 15+):**
```swift
// Use async notification sequence
for await _ in NotificationCenter.default.notifications(named: UserDefaults.didChangeNotification) {
    self.handleUserDefaultsDidChange()
}
```

**Also in:** `apps/ios/Sources/Settings/VoiceWakeWordsSettingsView.swift`, line 55 (uses `onReceive` with Combine publisher -- see M-8).

**Recommended Fix:** Replace callback-based observers with `NotificationCenter.default.notifications(named:)` async sequences in a `.task` modifier or dedicated Task.

### M-6: `DispatchQueue.asyncAfter` Usage

**Files:**
- `apps/ios/Sources/Gateway/TCPProbe.swift`, line 39
- `apps/ios/Sources/Gateway/GatewayConnectionController.swift`, line ~1016
- `apps/ios/ShareExtension/ShareViewController.swift`, line 142

**Current Code:**
```swift
queue.asyncAfter(deadline: .now() + timeoutSeconds) { finish(false) }
```

**Issue:** `DispatchQueue.asyncAfter` is a legacy GCD pattern. In Swift concurrency, `Task.sleep(nanoseconds:)` or `Task.sleep(for:)` is preferred. However, in `TCPProbe`, the GCD pattern is used within an `NWConnection` state handler context where a DispatchQueue is already in use, making it acceptable.

**Recommended Fix:**
- `TCPProbe.swift`: Acceptable as-is (NWConnection requires a DispatchQueue).
- `GatewayConnectionController.swift`: Replace with `Task.sleep` pattern.
- `ShareViewController.swift`: Replace with `Task.sleep` + `MainActor.run`.

### M-7: `objc_sync_enter`/`objc_sync_exit` and `objc_setAssociatedObject`

**File:** `apps/ios/Sources/Gateway/GatewayConnectionController.swift`, lines ~1039-1040, ~653

**Current Code:**
```swift
objc_sync_enter(connection)
// ...
objc_sync_exit(connection)
```
and
```swift
objc_setAssociatedObject(service, &resolvedKey, resolvedBox, .OBJC_ASSOCIATION_RETAIN)
```

**Issue:** These are Objective-C runtime patterns. Swift has modern alternatives:
- `OSAllocatedUnfairLock` (iOS 16+) or `Mutex` (proposed) for synchronization
- Property wrappers or Swift-native patterns for associated state

Note: `TCPProbe.swift` correctly uses `OSAllocatedUnfairLock` already.

**Recommended Fix:** Replace `objc_sync_enter`/`objc_sync_exit` with `OSAllocatedUnfairLock`. For `objc_setAssociatedObject`, this will naturally be eliminated when migrating away from `NetService` (see C-1).

### M-8: Combine `Timer.publish` and `onReceive` Usage

**Files:**
- `apps/ios/Sources/Onboarding/OnboardingWizardView.swift`, line ~72 (`Timer.publish`)
- `apps/ios/Sources/Settings/VoiceWakeWordsSettingsView.swift`, line 55 (`.onReceive(NotificationCenter.default.publisher(...))`)

**Current Code:**
```swift
@State private var autoAdvanceTimer = Timer.publish(every: 5.5, on: .main, in: .common).autoconnect()
// ...
.onReceive(self.autoAdvanceTimer) { _ in ... }
```

**Issue:** `Timer.publish` is a Combine pattern. Modern SwiftUI alternatives include:
- `.task { while !Task.isCancelled { ... try? await Task.sleep(...) } }` for recurring timers
- `TimelineView(.periodic(from:, by:))` for UI-driven periodic updates

**Recommended Fix:** Replace `Timer.publish` with a `.task`-based loop using `Task.sleep`. Replace `onReceive(NotificationCenter.default.publisher(...))` with `.task` + `NotificationCenter.default.notifications(named:)` async sequence.

---

## Low Findings

### L-1: `@unchecked Sendable` on `WatchConnectivityReceiver`

**File:** `apps/ios/WatchExtension/Sources/WatchConnectivityReceiver.swift`, line 21

**Current Code:**
```swift
final class WatchConnectivityReceiver: NSObject, @unchecked Sendable { ... }
```

**Issue:** `@unchecked Sendable` bypasses the compiler's sendability checks. The class holds a `WCSession?` and `WatchInboxStore` reference. Since `WatchInboxStore` is `@MainActor @Observable`, the receiver should ideally be restructured to use actor isolation or be marked `@MainActor`.

**Recommended Fix:** Consider making `WatchConnectivityReceiver` `@MainActor` or using an actor to protect shared state. The `WCSessionDelegate` methods dispatch to `@MainActor` already.

### L-2: `@unchecked Sendable` on `ScreenRecordService`

**File:** `apps/ios/Sources/Screen/ScreenRecordService.swift`

**Current Code:** Uses `@unchecked Sendable` with manual `NSLock`-based `CaptureState` synchronization.

**Issue:** Manual lock-based synchronization is error-prone. An actor would provide compiler-verified thread safety.

**Recommended Fix:** Consider converting `ScreenRecordService` to an actor, or at minimum replace `NSLock` with `OSAllocatedUnfairLock` for consistency with other parts of the codebase (e.g., `TCPProbe.swift`).

### L-3: `NSLock` Usage in `AudioBufferQueue`

**File:** `apps/ios/Sources/Voice/VoiceWakeManager.swift`, lines 15-38

**Current Code:**
```swift
private final class AudioBufferQueue: @unchecked Sendable {
    private let lock = NSLock()
    // ...
}
```

**Issue:** `NSLock` is a valid synchronization primitive but `OSAllocatedUnfairLock` (iOS 16+) is more efficient and is already used elsewhere in the codebase.

**Recommended Fix:** Replace `NSLock` with `OSAllocatedUnfairLock` for consistency and performance. Note: this class is intentionally `@unchecked Sendable` because it runs on a realtime audio thread where actor isolation is not appropriate -- the manual lock pattern is correct here; just the lock type could be modernized.

### L-4: `DateFormatter` Usage Instead of `.formatted()`

**File:** `apps/ios/Sources/Gateway/GatewayDiscoveryDebugLogView.swift`, lines 49-67

**Current Code:**
```swift
private static let timeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss"
    return formatter
}()
```

**Issue:** Since iOS 15, Swift provides `Date.formatted()` with `FormatStyle` which is more type-safe and concise. The `WatchInboxView.swift` already uses the modern pattern: `updatedAt.formatted(date: .omitted, time: .shortened)`.

**Recommended Fix:** Replace `DateFormatter` with `Date.formatted(.dateTime.hour().minute().second())` for the time format and `Date.ISO8601FormatStyle` for ISO formatting.

### L-5: `UIScreen.main.bounds` Usage

**File:** `apps/ios/ShareExtension/ShareViewController.swift`, line 31

**Current Code:**
```swift
self.preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: 420)
```

**Issue:** `UIScreen.main` is deprecated in iOS 16. In an extension context, `view.window?.windowScene?.screen` may not be available at `viewDidLoad` time, so the deprecation is harder to address here.

**Recommended Fix:** Since this is a share extension with limited lifecycle, this is acceptable. If refactoring, consider using trait collection or a fixed width, since the system manages extension sizing.

### L-6: String-Based `NSSortDescriptor` Key Path

**File:** `apps/ios/Sources/Media/PhotoLibraryService.swift`

**Current Code:**
```swift
NSSortDescriptor(key: "creationDate", ascending: false)
```

**Issue:** String-based key paths are not type-safe. While Photos framework requires `NSSortDescriptor`, this is a known limitation of the framework.

**Recommended Fix:** No change needed. The Photos framework API requires `NSSortDescriptor` with string keys.

---

## Positive Findings (Already Modern)

The following modern patterns are already correctly adopted throughout the codebase:

| Pattern | Status | Files |
|---------|--------|-------|
| `@Observable` (Observation framework) | Adopted | `NodeAppModel`, `GatewayConnectionController`, `GatewayDiscoveryModel`, `ScreenController`, `VoiceWakeManager`, `TalkModeManager`, `WatchInboxStore` |
| `@Environment(ModelType.self)` | Adopted | All views consistently use this pattern |
| `@Bindable` for two-way bindings | Adopted | `WatchInboxView`, various settings views |
| `NavigationStack` (not `NavigationView`) | Adopted | All navigation uses `NavigationStack` |
| Modern `onChange(of:) { _, newValue in }` | Adopted | All `onChange` modifiers use the two-parameter variant |
| `NWBrowser` (Network framework) | Adopted | `GatewayDiscoveryModel` for Bonjour discovery |
| `NWPathMonitor` (Network framework) | Adopted | `NetworkStatusService` |
| `DataScannerViewController` (VisionKit) | Adopted | `QRScannerView` for QR code scanning |
| `PhotosPicker` (PhotosUI) | Adopted | `OnboardingWizardView` |
| `OSAllocatedUnfairLock` | Adopted | `TCPProbe` |
| Swift 6 strict concurrency | Adopted | Project-wide `SWIFT_STRICT_CONCURRENCY: complete` |
| `actor` isolation | Adopted | `CameraController` uses `actor` |
| `@ObservationIgnored` | Adopted | `NodeAppModel` for non-tracked properties |
| `OSLog` / `Logger` | Adopted | Throughout the codebase |
| `async`/`await` | Adopted | Pervasive throughout the codebase |
| No `ObservableObject` / `@StateObject` | Correct | No legacy `ObservableObject` usage found |

---

## Prioritized Action Plan

### Phase 1: Critical (Immediate)
1. **Migrate `NetService` to Network framework** (C-1) -- `GatewayServiceResolver` and `GatewayConnectionController` Bonjour resolution

### Phase 2: High (Next Sprint)
2. **Remove dead `#available` checks** (H-1, H-2) -- `OpenClawApp.swift`, `CameraController.swift`
3. **Replace `UNUserNotificationCenter` callback wrappers** (H-3) -- `OpenClawApp.swift`
4. **Modernize `NSItemProvider` loading in Share Extension** (H-4) -- `ShareViewController.swift`

### Phase 3: Medium (Planned)
5. **Migrate `CLLocationManager` delegate to `CLLocationUpdate`** (M-1) -- `LocationService.swift`
6. **Replace `DispatchQueue.asyncAfter`** (M-6) -- `GatewayConnectionController.swift`, `ShareViewController.swift`
7. **Replace `objc_sync` with `OSAllocatedUnfairLock`** (M-7) -- `GatewayConnectionController.swift`
8. **Replace Combine `Timer.publish` and `onReceive`** (M-8) -- `OnboardingWizardView.swift`, `VoiceWakeWordsSettingsView.swift`
9. **Replace callback-based `NotificationCenter` observers** (M-5) -- `VoiceWakeManager.swift`

### Phase 4: Low (Opportunistic)
10. **Replace `NSLock` with `OSAllocatedUnfairLock`** (L-3) -- `VoiceWakeManager.swift`
11. **Modernize `DateFormatter` to `FormatStyle`** (L-4) -- `GatewayDiscoveryDebugLogView.swift`
12. **Address `@unchecked Sendable` patterns** (L-1, L-2) -- `WatchConnectivityReceiver`, `ScreenRecordService`

---

## Files Not Requiring Changes

The following files were audited and found to use modern patterns appropriately:

- `apps/ios/Sources/RootView.swift`
- `apps/ios/Sources/RootTabs.swift`
- `apps/ios/Sources/RootCanvas.swift`
- `apps/ios/Sources/Model/NodeAppModel+Canvas.swift`
- `apps/ios/Sources/Model/NodeAppModel+WatchNotifyNormalization.swift`
- `apps/ios/Sources/Chat/ChatSheet.swift`
- `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`
- `apps/ios/Sources/Voice/VoiceTab.swift`
- `apps/ios/Sources/Voice/VoiceWakePreferences.swift`
- `apps/ios/Sources/Gateway/GatewayDiscoveryModel.swift`
- `apps/ios/Sources/Gateway/GatewaySettingsStore.swift`
- `apps/ios/Sources/Gateway/GatewayHealthMonitor.swift`
- `apps/ios/Sources/Gateway/GatewayConnectConfig.swift`
- `apps/ios/Sources/Gateway/GatewayConnectionIssue.swift`
- `apps/ios/Sources/Gateway/GatewaySetupCode.swift`
- `apps/ios/Sources/Gateway/GatewayQuickSetupSheet.swift`
- `apps/ios/Sources/Gateway/GatewayTrustPromptAlert.swift`
- `apps/ios/Sources/Gateway/DeepLinkAgentPromptAlert.swift`
- `apps/ios/Sources/Gateway/KeychainStore.swift`
- `apps/ios/Sources/Screen/ScreenTab.swift`
- `apps/ios/Sources/Screen/ScreenWebView.swift`
- `apps/ios/Sources/Onboarding/GatewayOnboardingView.swift`
- `apps/ios/Sources/Onboarding/OnboardingStateStore.swift`
- `apps/ios/Sources/Status/StatusPill.swift`
- `apps/ios/Sources/Status/StatusGlassCard.swift`
- `apps/ios/Sources/Status/StatusActivityBuilder.swift`
- `apps/ios/Sources/Status/GatewayStatusBuilder.swift`
- `apps/ios/Sources/Status/GatewayActionsDialog.swift`
- `apps/ios/Sources/Status/VoiceWakeToast.swift`
- `apps/ios/Sources/Device/DeviceInfoHelper.swift`
- `apps/ios/Sources/Device/DeviceStatusService.swift`
- `apps/ios/Sources/Device/NetworkStatusService.swift`
- `apps/ios/Sources/Device/NodeDisplayName.swift`
- `apps/ios/Sources/Services/NodeServiceProtocols.swift`
- `apps/ios/Sources/Services/WatchMessagingService.swift`
- `apps/ios/Sources/Services/NotificationService.swift`
- `apps/ios/Sources/Settings/SettingsNetworkingHelpers.swift`
- `apps/ios/Sources/Capabilities/NodeCapabilityRouter.swift`
- `apps/ios/Sources/SessionKey.swift`
- `apps/ios/Sources/Calendar/CalendarService.swift`
- `apps/ios/Sources/Contacts/ContactsService.swift`
- `apps/ios/Sources/EventKit/EventKitAuthorization.swift`
- `apps/ios/Sources/Location/SignificantLocationMonitor.swift`
- `apps/ios/WatchExtension/Sources/OpenClawWatchApp.swift`
- `apps/ios/WatchExtension/Sources/WatchInboxStore.swift`
- `apps/ios/WatchExtension/Sources/WatchInboxView.swift`
- `apps/ios/WatchApp/` (asset catalog only)
