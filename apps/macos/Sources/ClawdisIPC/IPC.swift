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

public enum Request: Sendable {
    case notify(title: String, body: String, sound: String?)
    case ensurePermissions([Capability], interactive: Bool)
    case screenshot(displayID: UInt32?, windowID: UInt32?, format: String)
    case runShell(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeoutSec: Double?,
        needsScreenRecording: Bool)
    case status
    case agent(message: String, thinking: String?, session: String?)
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
        case title, body, sound
        case caps, interactive
        case displayID, windowID, format
        case command, cwd, env, timeoutSec, needsScreenRecording
        case message, thinking, session
    }

    private enum Kind: String, Codable {
        case notify
        case ensurePermissions
        case screenshot
        case runShell
        case status
        case agent
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .notify(title, body, sound):
            try container.encode(Kind.notify, forKey: .type)
            try container.encode(title, forKey: .title)
            try container.encode(body, forKey: .body)
            try container.encodeIfPresent(sound, forKey: .sound)

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

        case let .agent(message, thinking, session):
            try container.encode(Kind.agent, forKey: .type)
            try container.encode(message, forKey: .message)
            try container.encodeIfPresent(thinking, forKey: .thinking)
            try container.encodeIfPresent(session, forKey: .session)
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
            self = .notify(title: title, body: body, sound: sound)

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
            self = .agent(message: message, thinking: thinking, session: session)
        }
    }
}
