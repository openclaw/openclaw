import AppKit
import ApplicationServices
import AVFoundation
import CoreLocation
import Foundation
import OpenClawIPC
import OpenClawKit
import PeekabooAutomationKit
import Speech
import UserNotifications

extension Notification.Name {
    static let openclawPermissionsChanged = Notification.Name("openclaw.permissions.changed")
}

enum CapabilityAuthorizationStatus: Equatable, Sendable {
    case granted
    case notGranted
    case unknown
}

enum PermissionManager {
    @MainActor static let screenRecordingPermissions = PermissionsService()
    @MainActor static let screenRecordingState = ScreenRecordingPermissionState()
    @MainActor private(set) static var accessibilityRequestAttempted = false
    @MainActor private(set) static var eventPostingRequestAttempted = false
    private static let logger = Logger(subsystem: "ai.openclaw", category: "permissions")

    static func reportDeferredRequest() {
        self.logger.warning(
            "Permission dialog deferred by --no-activate; relaunch without the flag to grant access, then retry.")
    }

    /// UNUserNotificationCenter.current() aborts with NSInternalInconsistencyException
    /// ("bundleProxyForCurrentProcess is nil") in unbundled processes such as
    /// `swift build` dev binaries. Every notification-center call must check this
    /// first so unbundled invocations degrade to not-granted instead of crashing.
    static var notificationCenterAvailable: Bool {
        Bundle.main.bundleIdentifier != nil
    }

    static func isNotificationAuthorized(status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional
    }

    static func shouldOpenSpeechRecognitionSettings(
        status: SFSpeechRecognizerAuthorizationStatus,
        interactive: Bool) -> Bool
    {
        interactive && (status == .denied || status == .restricted)
    }

    static func isLocationAuthorized(status: CLAuthorizationStatus, requireAlways: Bool) -> Bool {
        if requireAlways { return status == .authorizedAlways }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            return true
        case .authorized: // deprecated, but still shows up on some macOS versions
            return true
        default:
            return false
        }
    }

    @MainActor
    static func ensure(
        _ caps: [Capability],
        interactive: Bool,
        isCurrent: @escaping @MainActor () -> Bool = { true }) async -> [Capability: Bool]
    {
        if interactive, !AppLaunchRuntimePlan.current.allowsActivation {
            self.reportDeferredRequest()
        }
        let interactive = interactive && AppLaunchRuntimePlan.current.allowsActivation
        var results: [Capability: Bool] = [:]
        for cap in caps {
            guard !Task.isCancelled, isCurrent() else { break }
            results[cap] = switch cap {
            case .notifications:
                await self.ensureNotifications(interactive: interactive, isCurrent: isCurrent)
            case .accessibility:
                self.ensureAccessibility(interactive: interactive, isCurrent: isCurrent)
            case .screenRecording:
                await self.ensureScreenRecording(interactive: interactive, isCurrent: isCurrent)
            case .microphone:
                await self.ensureCapture(
                    .audio,
                    capability: .microphone,
                    interactive: interactive,
                    isCurrent: isCurrent)
            case .speechRecognition:
                await self.ensureSpeechRecognition(interactive: interactive, isCurrent: isCurrent)
            case .camera:
                await self.ensureCapture(.video, capability: .camera, interactive: interactive, isCurrent: isCurrent)
            case .cameraEnabled:
                AppDefaults.standard.bool(forKey: cameraEnabledKey)
            case .location:
                await self.ensureLocation(interactive: interactive, isCurrent: isCurrent)
            case .eventPosting:
                self.ensureEventPosting(interactive: interactive, isCurrent: isCurrent)
            case .computerControl:
                isComputerControlEnabled()
            case .canvas:
                AppStateStore.shared.canvasEnabled
            }
        }
        if interactive {
            NotificationCenter.default.post(name: .openclawPermissionsChanged, object: nil)
        }
        return results
    }

    @MainActor
    private static func ensureNotifications(
        interactive: Bool, isCurrent: @MainActor () -> Bool) async -> Bool
    {
        guard self.notificationCenterAvailable else { return false }
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if self.isNotificationAuthorized(status: settings.authorizationStatus) {
            return true
        }
        if settings.authorizationStatus == .notDetermined {
            guard interactive, !Task.isCancelled, isCurrent() else { return false }
            let granted = await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            let updated = await center.notificationSettings()
            return granted && self.isNotificationAuthorized(status: updated.authorizationStatus)
        }
        if settings.authorizationStatus == .denied, interactive, !Task.isCancelled, isCurrent() {
            SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: .notifications))
        }
        return false
    }

    @MainActor private static func ensureAccessibility(
        interactive: Bool, isCurrent: @MainActor () -> Bool) -> Bool
    {
        if interactive, !AXIsProcessTrusted(), !Task.isCancelled, isCurrent() {
            self.accessibilityRequestAttempted = true
            let opts: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
            _ = AXIsProcessTrustedWithOptions(opts)
        }
        return AXIsProcessTrusted()
    }

    @MainActor
    private static func ensureScreenRecording(
        interactive: Bool, isCurrent: @MainActor () -> Bool) async -> Bool
    {
        await self.screenRecordingState.ensure(
            interactive: interactive,
            isCurrent: isCurrent,
            check: { await self.screenRecordingPermissions.checkScreenRecordingPermissionLive(forceProbe: $0) },
            request: { self.screenRecordingPermissions.requestScreenRecordingPermission() },
            openSettings: {
                SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: .screenRecording))
            })
    }

    @MainActor
    private static func ensureCapture(
        _ mediaType: AVMediaType,
        capability: Capability,
        interactive: Bool,
        isCurrent: @MainActor () -> Bool) async -> Bool
    {
        let status = AVCaptureDevice.authorizationStatus(for: mediaType)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            guard interactive, !Task.isCancelled, isCurrent() else { return false }
            return await AVCaptureDevice.requestAccess(for: mediaType)
        case .denied, .restricted:
            if interactive, !Task.isCancelled, isCurrent() {
                SystemSettingsURLSupport.openPrivacySettings(for: capability)
            }
            return false
        @unknown default:
            return false
        }
    }

    @MainActor
    private static func ensureSpeechRecognition(
        interactive: Bool, isCurrent: @MainActor () -> Bool) async -> Bool
    {
        let status = SFSpeechRecognizer.authorizationStatus()
        if self.shouldOpenSpeechRecognitionSettings(status: status, interactive: interactive),
           !Task.isCancelled, isCurrent()
        {
            SystemSettingsURLSupport.openPrivacySettings(for: .speechRecognition)
        }
        if status == .notDetermined, interactive, !Task.isCancelled, isCurrent() {
            await withUnsafeContinuation { (cont: UnsafeContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in
                    DispatchQueue.main.async { cont.resume() }
                }
            }
        }
        return SFSpeechRecognizer.authorizationStatus() == .authorized
    }

    @MainActor
    private static func ensureLocation(
        interactive: Bool, isCurrent: @escaping @MainActor () -> Bool) async -> Bool
    {
        let requireAlways = AppDefaults.standard.string(forKey: locationModeKey) == OpenClawLocationMode.always.rawValue
        let status = LocationPermissionRequester.shared.authorizationStatus
        if self.isLocationAuthorized(status: status, requireAlways: requireAlways) { return true }
        switch status {
        case .authorizedAlways, .authorizedWhenInUse, .authorized, .notDetermined:
            guard interactive, !Task.isCancelled, isCurrent() else { return false }
            let updated = await LocationPermissionRequester.shared.request(always: requireAlways, isCurrent: isCurrent)
            return self.isLocationAuthorized(status: updated, requireAlways: requireAlways)
        case .denied, .restricted:
            if interactive, !Task.isCancelled, isCurrent() {
                SystemSettingsURLSupport.openPrivacySettings(for: .location)
            }
            return false
        @unknown default:
            return false
        }
    }

    @MainActor
    private static func ensureEventPosting(interactive: Bool, isCurrent: @MainActor () -> Bool) -> Bool {
        guard !Task.isCancelled, isCurrent() else { return false }
        if interactive { self.eventPostingRequestAttempted = true }
        let granted = self.screenRecordingPermissions.requestPostEventPermission(interactive: interactive)
        if interactive, !granted, !Task.isCancelled, isCurrent() {
            SystemSettingsURLSupport.openFirst(SystemSettingsURLSupport.settingsCandidates(for: .eventPosting))
        }
        return granted
    }

    static func voiceWakePermissionsGranted() -> Bool {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let speech = SFSpeechRecognizer.authorizationStatus() == .authorized
        return mic && speech
    }

    static func locationAuthorizationStatus() async -> CLAuthorizationStatus {
        await LocationPermissionRequester.shared.authorizationStatus
    }

    static func ensureVoiceWakePermissions(interactive: Bool) async -> Bool {
        let results = await self.ensure([.microphone, .speechRecognition], interactive: interactive)
        return results[.microphone] == true && results[.speechRecognition] == true
    }

    static func authorizationStatus(
        _ caps: [Capability] = Capability.allCases) async -> [Capability: CapabilityAuthorizationStatus]
    {
        await self.grantedStatus(caps).mapValues { $0 ? .granted : .notGranted }
    }

    static func grantedStatus(_ caps: [Capability] = Capability.allCases) async -> [Capability: Bool] {
        await self.ensure(caps, interactive: false)
    }
}

@MainActor
final class LocationPermissionRequestCoordinator {
    private struct Request {
        let continuation: CheckedContinuation<CLAuthorizationStatus, Never>
        let isCurrent: @MainActor () -> Bool
    }

    private var requests: [Request] = []

    var hasPendingRequests: Bool {
        !self.requests.isEmpty
    }

    var pendingRequestCount: Int {
        self.requests.count
    }

    var hasCurrentRequests: Bool {
        self.requests.contains { $0.isCurrent() }
    }

    func wait(
        isCurrent: @escaping @MainActor () -> Bool = { true },
        onEnqueue: (_ isFirstRequest: Bool) -> Void) async -> CLAuthorizationStatus
    {
        await withCheckedContinuation { continuation in
            let isFirstRequest = self.requests.isEmpty
            self.requests.append(Request(continuation: continuation, isCurrent: isCurrent))
            onEnqueue(isFirstRequest)
        }
    }

    func finish(status: CLAuthorizationStatus) {
        let requests = self.requests
        self.requests.removeAll()
        for request in requests {
            request.continuation.resume(returning: status)
        }
    }
}

@MainActor
final class LocationPermissionRequester: NSObject, CLLocationManagerDelegate {
    static let shared = LocationPermissionRequester()
    private let manager: CLLocationManager
    private let openSettings: @MainActor () -> Void
    private let locationServicesEnabled: @MainActor () -> Bool
    private let requests = LocationPermissionRequestCoordinator()
    private var timeoutTask: Task<Void, Never>?
    private var requestedAlways = false

    init(
        manager: CLLocationManager = CLLocationManager(),
        locationServicesEnabled: @escaping @MainActor () -> Bool = { CLLocationManager.locationServicesEnabled() },
        openSettings: @escaping @MainActor () -> Void = {
            SystemSettingsURLSupport.openPrivacySettings(for: .location)
        })
    {
        self.manager = manager
        self.locationServicesEnabled = locationServicesEnabled
        self.openSettings = openSettings
        super.init()
        self.manager.delegate = self
    }

    var authorizationStatus: CLAuthorizationStatus {
        // Reuse the process-lifetime manager; system-wide disablement overrides its cached per-app grant.
        self.locationServicesEnabled() ? self.manager.authorizationStatus : .denied
    }

    func request(
        always: Bool, isCurrent: @escaping @MainActor () -> Bool = { true }) async -> CLAuthorizationStatus
    {
        let current = self.authorizationStatus
        if PermissionManager.isLocationAuthorized(status: current, requireAlways: always) {
            return current
        }
        guard !Task.isCancelled, isCurrent() else { return current }
        guard AppLaunchRuntimePlan.current.allowsActivation else {
            PermissionManager.reportDeferredRequest()
            return current
        }
        if current == .denied || current == .restricted {
            self.openSettings()
            return current
        }

        // The enqueue callback runs synchronously before wait suspends, so the
        // authority check above also covers the requests made inside it.
        return await self.requests.wait(isCurrent: isCurrent) { isFirstRequest in
            if isFirstRequest {
                self.requestedAlways = always
                self.scheduleTimeout()
                self.requestAuthorization(always: always)
                // On macOS, requesting an actual fix makes the prompt more reliable.
                self.manager.requestLocation()
            } else if always, !self.requestedAlways {
                self.requestedAlways = true
                self.manager.requestAlwaysAuthorization()
            }
        }
    }

    private func requestAuthorization(always: Bool) {
        if always {
            self.manager.requestAlwaysAuthorization()
        } else {
            self.manager.requestWhenInUseAuthorization()
        }
    }

    private func scheduleTimeout() {
        self.timeoutTask?.cancel()
        self.timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 3_000_000_000)
            } catch {
                return
            }
            guard !Task.isCancelled, let self, self.requests.hasPendingRequests else { return }
            if self.requests.hasCurrentRequests {
                self.openSettings()
            }
            self.finish(status: self.manager.authorizationStatus)
        }
    }

    private func finish(status: CLAuthorizationStatus) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.requestedAlways = false
        self.requests.finish(status: status)
    }

    /// nonisolated for Swift 6 strict concurrency compatibility
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        self.locationManager(manager, didChangeAuthorization: manager.authorizationStatus)
    }

    /// Legacy callback (still used on some macOS versions / configurations).
    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didChangeAuthorization status: CLAuthorizationStatus)
    {
        Task { @MainActor in
            self.finish(status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if self.requests.hasCurrentRequests, status == .denied || status == .restricted {
                self.openSettings()
            }
            self.finish(status: status)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        self.locationManager(manager, didChangeAuthorization: manager.authorizationStatus)
    }
}
