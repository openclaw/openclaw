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
}

// MARK: - Requests

/// Notification interruption level (maps to UNNotificationInterruptionLevel)
public enum NotificationPriority: String, Codable, Sendable {
    case passive      // silent, no wake
    case active       // default
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

public enum Request: Sendable {
    case notify(
        title: String,
        body: String,
        sound: String?,
        priority: NotificationPriority?,
        delivery: NotificationDelivery?)
    case ensurePermissions([Capability], interactive: Bool)
    case screenshot(displayID: UInt32?, windowID: UInt32?, format: String)
    case runShell(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeoutSec: Double?,
        needsScreenRecording: Bool)
    case status
    case agent(message: String, thinking: String?, session: String?, deliver: Bool, to: String?)
    case rpcStatus
    case canvasShow(session: String, path: String?, placement: CanvasPlacement?)
    case canvasHide(session: String)
    case canvasGoto(session: String, path: String, placement: CanvasPlacement?)
    case canvasEval(session: String, javaScript: String)
    case canvasSnapshot(session: String, outPath: String?)
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

// MARK: - Codable conformance for Request

extension Request: Codable {
    private enum CodingKeys: String, CodingKey {
        case type
        case title, body, sound, priority, delivery
        case caps, interactive
        case displayID, windowID, format
        case command, cwd, env, timeoutSec, needsScreenRecording
        case message, thinking, session, deliver, to
        case rpcStatus
        case path
        case javaScript
        case outPath
        case placement
    }

    private enum Kind: String, Codable {
        case notify
        case ensurePermissions
        case screenshot
        case runShell
        case status
        case agent
        case rpcStatus
        case canvasShow
        case canvasHide
        case canvasGoto
        case canvasEval
        case canvasSnapshot
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .notify(title, body, sound, priority, delivery):
            try container.encode(Kind.notify, forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(body, forKey: .body)
            try container.encodeIfPresent(sound, forKey: .sound)
            try container.encodeIfPresent(priority, forKey: .priority)
            try container.encodeIfPresent(delivery, forKey: .delivery)

        case let .ensurePermissions(caps, interactive):
            try container.encode(Kind.ensurePermissions, forKey: .type)
            try container.encode(caps, forKey: .caps)
            try container.encode(interactive, forKey: .interactive)

        case let .screenshot(displayID, windowID, format):
            try container.encode(Kind.screenshot, forKey: .type)
            try container.encodeIfPresent(displayID, forKey: .displayID)
            try container.encodeIfPresent(windowID, forKey: .windowID)
            try container.encode(format, forKey: .format)

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            try container.encode(Kind.runShell, forKey: .type)
            try container.encode(command, forKey: .command)
            try container.encodeIfPresent(cwd, forKey: .cwd)
            try container.encodeIfPresent(env, forKey: .env)
            try container.encodeIfPresent(timeoutSec, forKey: .timeoutSec)
            try container.encode(needsSR, forKey: .needsScreenRecording)

        case .status:
            try container.encode(Kind.status, forKey: .type)

        case let .agent(message, thinking, session, deliver, to):
            try container.encode(Kind.agent, forKey: .type)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(thinking, forKey: .thinking)
            try container.encodeIfPresent(session, forKey: .session)
            try container.encode(deliver, forKey: .deliver)
            try container.encodeIfPresent(to, forKey: .to)

        case .rpcStatus:
            try container.encode(Kind.rpcStatus, forKey: .type)

        case let .canvasShow(session, path, placement):
            try container.encode(Kind.canvasShow, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encodeIfPresent(path, forKey: .path)
            try container.encodeIfPresent(placement, forKey: .placement)

        case let .canvasHide(session):
            try container.encode(Kind.canvasHide, forKey: .type)
            try container.encode(session, forKey: .session)

        case let .canvasGoto(session, path, placement):
            try container.encode(Kind.canvasGoto, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encode(path, forKey: .path)
            try container.encodeIfPresent(placement, forKey: .placement)

        case let .canvasEval(session, javaScript):
            try container.encode(Kind.canvasEval, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encode(javaScript, forKey: .javaScript)

        case let .canvasSnapshot(session, outPath):
            try container.encode(Kind.canvasSnapshot, forKey: .type)
            try container.encode(session, forKey: .session)
            try container.encodeIfPresent(outPath, forKey: .outPath)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .type)
        switch kind {
        case .notify:
            let title = try container.decode(String.self, forKey: .title)
            let body = try container.decode(String.self, forKey: .body)
            let sound = try container.decodeIfPresent(String.self, forKey: .sound)
            let priority = try container.decodeIfPresent(NotificationPriority.self, forKey: .priority)
            let delivery = try container.decodeIfPresent(NotificationDelivery.self, forKey: .delivery)
            self = .notify(title: title, body: body, sound: sound, priority: priority, delivery: delivery)

        case .ensurePermissions:
            let caps = try container.decode([Capability].self, forKey: .caps)
            let interactive = try container.decode(Bool.self, forKey: .interactive)
            self = .ensurePermissions(caps, interactive: interactive)

        case .screenshot:
            let displayID = try container.decodeIfPresent(UInt32.self, forKey: .displayID)
            let windowID = try container.decodeIfPresent(UInt32.self, forKey: .windowID)
            let format = try container.decode(String.self, forKey: .format)
            self = .screenshot(displayID: displayID, windowID: windowID, format: format)

        case .runShell:
            let command = try container.decode([String].self, forKey: .command)
            let cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
            let env = try container.decodeIfPresent([String: String].self, forKey: .env)
            let timeout = try container.decodeIfPresent(Double.self, forKey: .timeoutSec)
            let needsSR = try container.decode(Bool.self, forKey: .needsScreenRecording)
            self = .runShell(command: command, cwd: cwd, env: env, timeoutSec: timeout, needsScreenRecording: needsSR)

        case .status:
            self = .status

        case .agent:
            let message = try container.decode(String.self, forKey: .message)
            let thinking = try container.decodeIfPresent(String.self, forKey: .thinking)
            let session = try container.decodeIfPresent(String.self, forKey: .session)
            let deliver = try container.decode(Bool.self, forKey: .deliver)
            let to = try container.decodeIfPresent(String.self, forKey: .to)
            self = .agent(message: message, thinking: thinking, session: session, deliver: deliver, to: to)

        case .rpcStatus:
            self = .rpcStatus

        case .canvasShow:
            let session = try container.decode(String.self, forKey: .session)
            let path = try container.decodeIfPresent(String.self, forKey: .path)
            let placement = try container.decodeIfPresent(CanvasPlacement.self, forKey: .placement)
            self = .canvasShow(session: session, path: path, placement: placement)

        case .canvasHide:
            let session = try container.decode(String.self, forKey: .session)
            self = .canvasHide(session: session)

        case .canvasGoto:
            let session = try container.decode(String.self, forKey: .session)
            let path = try container.decode(String.self, forKey: .path)
            let placement = try container.decodeIfPresent(CanvasPlacement.self, forKey: .placement)
            self = .canvasGoto(session: session, path: path, placement: placement)

        case .canvasEval:
            let session = try container.decode(String.self, forKey: .session)
            let javaScript = try container.decode(String.self, forKey: .javaScript)
            self = .canvasEval(session: session, javaScript: javaScript)

        case .canvasSnapshot:
            let session = try container.decode(String.self, forKey: .session)
            let outPath = try container.decodeIfPresent(String.self, forKey: .outPath)
            self = .canvasSnapshot(session: session, outPath: outPath)
        }
    }
}

// Shared transport settings
public let controlSocketPath =
    FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/clawdis/control.sock")
        .path
