import OpenClawIPC
import OpenClawKit

extension DeviceSettingsPermission {
    static let macOSPermissions: [Self] = [
        .notifications, .accessibility, .screenRecording, .microphone,
        .camera, .speechRecognition, .location,
    ]

    var capability: Capability? {
        switch self {
        case .notifications: .notifications
        case .accessibility: .accessibility
        case .screenRecording: .screenRecording
        case .microphone: .microphone
        case .camera: .camera
        case .speechRecognition: .speechRecognition
        case .location: .location
        case .contacts, .calendars, .reminders, .photos: nil
        }
    }
}

extension DeviceSettingsPermissionStatus {
    init(_ status: CapabilityAuthorizationStatus?) {
        switch status {
        case .granted: self = .granted
        // Binary macOS checks cannot distinguish a denial from an unrequested grant.
        // Keep them requestable using the vocabulary understood by shipped Gateway UIs.
        case .notGranted: self = .notDetermined
        case .unknown, nil: self = .unavailable
        }
    }
}
