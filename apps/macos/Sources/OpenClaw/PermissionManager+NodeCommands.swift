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
    /// All native command failures use this owner, including failures found at the effect boundary.
    static func missingPermission(
        _ states: [(Capability, OpenClawPermissionState)]) -> OpenClawNodeError?
    {
        guard let remediation = self.primaryRemediation(states) else { return nil }
        let capabilities = states.map(\.0.rawValue)
        return OpenClawNodeError(
            code: .permissionMissing,
            message: "PERMISSION_MISSING: \(capabilities.joined(separator: ", "))",
            details: .init(capabilities: capabilities, state: remediation.state))
    }

    static func primaryRemediation(
        _ states: [(Capability, OpenClawPermissionState)])
        -> (capabilities: [Capability], state: OpenClawPermissionState)?
    {
        let priority: [OpenClawPermissionState] = [
            .disabledInOpenClaw, .staleGrant, .restartRequired, .denied, .notDetermined,
        ]
        guard let state = priority.first(where: { candidate in states.contains { $0.1 == candidate } }) else {
            return nil
        }
        // Repair one state per action. Opening Settings does not complete a grant,
        // so lower-priority recovery must wait for a refreshed permission snapshot.
        return (states.filter { $0.1 == state }.map(\.0), state)
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
            return self.accessibilityMissingState(
                snapshot.inputAccess, requestAttempted: self.accessibilityRequestAttempted)
        case .eventPosting:
            return self.eventPostingMissingState(
                granted: self.screenRecordingPermissions.checkPostEventPermission(),
                requestAttempted: self.eventPostingRequestAttempted)
        case .screenRecording:
            let granted = await self.screenRecordingPermissions.checkScreenRecordingPermissionLive()
            return self.screenRecordingState.missingState(granted: granted)
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
        case .cameraEnabled, .computerControl, .canvas:
            return await self.ensure([capability], interactive: false)[capability] == true ? nil : .disabledInOpenClaw
        }
    }

    static func accessibilityMissingState(
        _ access: ComputerControlPermissionSnapshot.InputAccess,
        requestAttempted: Bool) -> OpenClawPermissionState?
    {
        switch access {
        case .granted, .postEventMissing: nil
        case .accessibilityMissing: .notDetermined
        case .accessibilityGrantMayBeStale: requestAttempted ? .staleGrant : .notDetermined
        }
    }

    static func eventPostingMissingState(granted: Bool, requestAttempted: Bool) -> OpenClawPermissionState? {
        granted ? nil : requestAttempted ? .restartRequired : .notDetermined
    }

    @MainActor
    static func screenCaptureFailure(_ error: any Error) -> (any Error) {
        let error = error as NSError
        guard error.domain == SCStreamErrorDomain, error.code == -3801 else {
            return error
        }
        self.screenRecordingState.needsRestart = self.screenRecordingPermissions.checkScreenRecordingPermission()
        self.screenRecordingState.requestAttempted = true
        return self.missingPermission([(
            .screenRecording, self.screenRecordingState.needsRestart ? .restartRequired : .denied)])!
    }
}
