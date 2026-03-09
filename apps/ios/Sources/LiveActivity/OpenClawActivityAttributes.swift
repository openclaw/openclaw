import ActivityKit
import Foundation

/// Shared schema used by iOS app + Live Activity widget extension.
struct OpenClawActivityAttributes: ActivityAttributes {
    var agentName: String
    var sessionKey: String

    struct ContentState: Hashable {
        var statusText: String
        var isIdle: Bool
        var isDisconnected: Bool
        var isConnecting: Bool
        /// `true` when the agent is actively processing a task.
        var isWorking: Bool
        /// Short description of the current task (e.g. "Building iOS app…", "Searching…").
        /// Non-nil only when `isWorking` is `true`.
        var taskDescription: String?
        var startedAt: Date
    }
}

// MARK: - Codable

/// Custom Codable conformance so new fields (`isWorking`, `taskDescription`) default
/// gracefully when decoding persisted Live Activity state from an older app version.
extension OpenClawActivityAttributes.ContentState: Codable {
    private enum CodingKeys: String, CodingKey {
        case statusText, isIdle, isDisconnected, isConnecting
        case isWorking, taskDescription, startedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        statusText      = try c.decode(String.self, forKey: .statusText)
        isIdle          = try c.decode(Bool.self,   forKey: .isIdle)
        isDisconnected  = try c.decode(Bool.self,   forKey: .isDisconnected)
        isConnecting    = try c.decode(Bool.self,   forKey: .isConnecting)
        startedAt       = try c.decode(Date.self,   forKey: .startedAt)
        // Default to false/nil when decoding persisted state from an older build
        // that pre-dates these fields — prevents Live Activity decode failures on update.
        isWorking       = try c.decodeIfPresent(Bool.self,   forKey: .isWorking)      ?? false
        taskDescription = try c.decodeIfPresent(String.self, forKey: .taskDescription)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(statusText,     forKey: .statusText)
        try c.encode(isIdle,         forKey: .isIdle)
        try c.encode(isDisconnected, forKey: .isDisconnected)
        try c.encode(isConnecting,   forKey: .isConnecting)
        try c.encode(isWorking,      forKey: .isWorking)
        try c.encode(startedAt,      forKey: .startedAt)
        try c.encodeIfPresent(taskDescription, forKey: .taskDescription)
    }
}

// MARK: - Debug previews

#if DEBUG
extension OpenClawActivityAttributes {
    static let preview = OpenClawActivityAttributes(agentName: "J.A.R.V.I.S.", sessionKey: "main")
}

extension OpenClawActivityAttributes.ContentState {
    static let connecting = OpenClawActivityAttributes.ContentState(
        statusText: "Connecting...",
        isIdle: false,
        isDisconnected: false,
        isConnecting: true,
        isWorking: false,
        taskDescription: nil,
        startedAt: .now)

    static let idle = OpenClawActivityAttributes.ContentState(
        statusText: "Connected",
        isIdle: true,
        isDisconnected: false,
        isConnecting: false,
        isWorking: false,
        taskDescription: nil,
        startedAt: .now)

    static let disconnected = OpenClawActivityAttributes.ContentState(
        statusText: "Disconnected",
        isIdle: false,
        isDisconnected: true,
        isConnecting: false,
        isWorking: false,
        taskDescription: nil,
        startedAt: .now)

    static func working(task: String) -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: task,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            isWorking: true,
            taskDescription: task,
            startedAt: .now)
    }
}
#endif
