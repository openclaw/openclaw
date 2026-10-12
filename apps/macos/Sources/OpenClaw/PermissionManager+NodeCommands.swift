import ApplicationServices
import AVFoundation
import CoreLocation
import Foundation
import OpenClawIPC
import OpenClawKit
import ScreenCaptureKit
import Speech
import UserNotifications

extension PermissionManager {
    @MainActor private static var screenCaptureNeedsRestart = false
    /// All native command failures use this owner, including failures found at the effect boundary.
    static func missingPermission(
        _ states: [(Capability, OpenClawPermissionState)]) -> OpenClawNodeError?
    {
        guard !states.isEmpty else { return nil }
        let priority: [OpenClawPermissionState] = [
            .disabledInOpenClaw, .staleGrant, .restartRequired, .denied, .notDetermined,
        ]
        // One card can contain several capabilities. Resolve consent before OS grants,
        // then re-read each capability after the user acts rather than assume success.
        let state = priority.first { candidate in states.contains { $0.1 == candidate } }!
        let capabilities = states.map(\.0.rawValue)
        return OpenClawNodeError(
            code: .permissionMissing,
            message: "PERMISSION_MISSING: \(capabilities.joined(separator: ", "))",
            details: .init(capabilities: capabilities, state: state))
    }

    @MainActor
    static func missingPermissions(
        _ capabilities: [Capability], disabled: [Capability] = []) async -> OpenClawNodeError?
    {
        var states: [(Capability, OpenClawPermissionState)] = []
        for capability in capabilities {
            if disabled.contains(capability) {
                states.append((capability, .disabledInOpenClaw))
            } else if let state = await self.missingState(capability) {
                states.append((capability, state))
            }
        }
        return self.missingPermission(states)
    }

    @MainActor
    static func missingState(_ capability: Capability) async -> OpenClawPermissionState? {
        switch capability {
        case .accessibility:
            let snapshot = ComputerControlPermissionSnapshot.probe()
            guard snapshot.accessibility == .missing else { return nil }
            return snapshot.inputAccess == .accessibilityGrantMayBeStale ? .staleGrant : .notDetermined
        case .eventPosting:
            return self.screenRecordingPermissions.checkPostEventPermission() ? nil : .notDetermined
        case .screenRecording:
            if self.screenCaptureNeedsRestart { return .restartRequired }
            return await self.screenRecordingPermissions.checkScreenRecordingPermissionLive() ? nil : .notDetermined
        case .camera, .microphone:
            switch AVCaptureDevice.authorizationStatus(for: capability == .camera ? .video : .audio) {
            case .authorized: return nil
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        case .speechRecognition:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: return nil
            case .notDetermined: return .notDetermined
            default: return .denied
            }
        case .location:
            guard CLLocationManager.locationServicesEnabled() else { return .denied }
            let status = await self.locationAuthorizationStatus()
            let requireAlways = AppDefaults.standard.string(forKey: locationModeKey) ==
                OpenClawLocationMode.always.rawValue
            if self.isLocationAuthorized(status: status, requireAlways: requireAlways) { return nil }
            let requestable = status == .notDetermined ||
                self.isLocationAuthorized(status: status, requireAlways: false)
            return requestable ? .notDetermined : .denied
        case .notifications:
            guard self.notificationCenterAvailable else { return .notDetermined }
            let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            return self.isNotificationAuthorized(status: status)
                ? nil : status == .notDetermined ? .notDetermined : .denied
        case .computerControl:
            return isComputerControlEnabled() ? nil : .disabledInOpenClaw
        case .canvas:
            return AppStateStore.shared.canvasEnabled ? nil : .disabledInOpenClaw
        }
    }

    @MainActor
    static func screenCaptureFailure(_ error: any Error) -> (any Error) {
        let error = error as NSError
        guard error.domain == SCStreamErrorDomain, error.code == -3801 else {
            return error
        }
        self.screenCaptureNeedsRestart = self.screenRecordingPermissions.checkScreenRecordingPermission()
        return self.missingPermission([(
            .screenRecording, self.screenCaptureNeedsRestart ? .restartRequired : .denied)])!
    }
}
