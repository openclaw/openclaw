import Foundation

public enum OpenClawCapability: String, Codable, Sendable {
    case canvas
    case camera
    case screen
    case voiceWake
    case location
    case device
    case watch
    case photos
    case contacts
    case calendar
    case reminders
    case motion
}
