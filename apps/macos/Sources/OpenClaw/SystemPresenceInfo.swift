import CoreGraphics
import Foundation

enum SystemPresenceInfo {
    static func lastHardwareInputSeconds() -> Int? {
        let anyEvent = CGEventType(rawValue: UInt32.max) ?? .null
        let seconds = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyEvent)
        guard seconds.isFinite, seconds >= 0 else { return nil }
        return Int(seconds.rounded())
    }
}
