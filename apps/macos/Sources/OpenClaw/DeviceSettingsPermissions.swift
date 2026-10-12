import OpenClawIPC
import OpenClawKit

extension DeviceSettingsPermission {
    static let macOSPermissions: [Self] = [
        .notifications, .accessibility, .screenRecording, .microphone,
        .camera, .speechRecognition, .location, .eventPosting,
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
        case .eventPosting: .eventPosting
        case .contacts, .calendars, .reminders, .photos: nil
        }
    }
}
