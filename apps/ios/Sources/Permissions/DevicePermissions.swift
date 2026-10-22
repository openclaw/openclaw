import Contacts
import EventKit
import OpenClawKit
import Photos

/// Native authorization states map directly to the shared snapshot vocabulary.
enum DevicePermissionStatusMap {
    static func contacts(_ status: CNAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        switch status {
        case .authorized: .granted
        case .limited: .limited
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    static func photos(_ status: PHAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        switch status {
        case .authorized: .granted
        case .limited: .limited
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    /// Full read access; `.writeOnly` surfaces as `.limited` ("Add-Only").
    static func eventKitRead(_ status: EKAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        switch status {
        case .authorized, .fullAccess: .granted
        case .writeOnly: .limited
        case .notDetermined: .notDetermined
        case .denied, .restricted: .denied
        @unknown default: .denied
        }
    }

    /// Add-events access; `.writeOnly` already satisfies it.
    static func eventKitWrite(_ status: EKAuthorizationStatus) -> DeviceSettingsPermissionStatus {
        status == .writeOnly ? .granted : self.eventKitRead(status)
    }
}
