import CoreGraphics
import Foundation

// MARK: - Capabilities

public enum Capability: String, Codable, CaseIterable, Sendable {
    /// AppleScript / Automation access to control other apps (TCC Automation).
    case appleScript
    case notifications
    case accessibility
    case screenRecording
    case microphone
    case speechRecognition
    case camera
    case location
}

public enum CameraFacing: String, Codable, Sendable {
    case front
    case back
}

// MARK: - Requests

/// Notification interruption level (maps to UNNotificationInterruptionLevel)
public enum NotificationPriority: String, Codable, Sendable {
    case passive // silent, no wake
    case active // default
    case timeSensitive // breaks through Focus modes
}

/// Notification delivery mechanism.
public enum NotificationDelivery: String, Codable, Sendable {
    /// Use macOS notification center (UNUserNotificationCenter).
    case system
    /// Use an in-app overlay/toast (no Notification Center history).
    case overlay
    /// Prefer system; fall back to overlay when system isn't available.
    case auto
}

// MARK: - Canvas geometry

/// Optional placement hints for the Canvas panel.
/// Values are in screen coordinates (same as `NSWindow` frame).
public struct CanvasPlacement: Codable, Sendable {
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?

    public init(x: Double? = nil, y: Double? = nil, width: Double? = nil, height: Double? = nil) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

// MARK: - Responses

public struct Response: Codable, Sendable {
    public var ok: Bool
    public var message: String?
    /// Optional payload (PNG bytes, stdout text, etc.).
    public var payload: Data?

    public init(ok: Bool, message: String? = nil, payload: Data? = nil) {
        self.ok = ok
        self.message = message
        self.payload = payload
    }
}
