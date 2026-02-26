import ActivityKit
import Foundation

/// Shared definition compiled by both the main app and the widget extension.
struct OpenClawActivityAttributes: ActivityAttributes {
    /// Agent display name (set once when the activity starts).
    var agentName: String
    /// Session key so the widget can scope its display.
    var sessionKey: String

    struct ContentState: Codable, Hashable {
        /// Short AI-generated subject line (latched from first streaming text).
        var subject: String?
        /// Human-readable status ("Thinking...", "Reading config.json...", "Done", "Connected").
        var statusText: String
        /// Friendly label for the current tool (nil when idle/thinking).
        var currentToolLabel: String?
        /// SF Symbol name for the current tool category.
        var currentToolIcon: String?
        /// Friendly label for the most recently completed tool.
        var previousToolLabel: String?
        /// Number of tool steps executed so far.
        var toolStepCount: Int
        /// First ~80 chars of streaming assistant text (truncated).
        var streamingText: String?
        /// Activity completed successfully (last run).
        var isFinished: Bool
        /// Activity ended with an error (last run).
        var isError: Bool
        /// Whether the gateway is connected but idle (no active run).
        var isIdle: Bool
        /// Whether the gateway is disconnected.
        var isDisconnected: Bool
        /// Whether the gateway is currently connecting.
        var isConnecting: Bool
        /// When the activity started (drives the live timer).
        var startedAt: Date
        /// When the last run ended (nil while running or idle).
        var endedAt: Date?
    }
}

// MARK: - Preview Helpers

#if DEBUG
extension OpenClawActivityAttributes {
    static let preview = OpenClawActivityAttributes(agentName: "main", sessionKey: "main")
}

extension OpenClawActivityAttributes.ContentState {
    static let connecting = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Connecting...",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
        toolStepCount: 0, streamingText: nil,
        isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: true, startedAt: .now)

    static let idle = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Idle",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
        toolStepCount: 0, streamingText: nil,
        isFinished: false, isError: false, isIdle: true, isDisconnected: false, isConnecting: false, startedAt: .now)

    static let disconnected = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Disconnected",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
        toolStepCount: 0, streamingText: nil,
        isFinished: false, isError: false, isIdle: false, isDisconnected: true, isConnecting: false, startedAt: .now)

    static let thinking = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Thinking...",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
        toolStepCount: 0, streamingText: nil,
        isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: false, startedAt: .now)

    static let toolRunning = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Searching the web...",
        currentToolLabel: "Searching the web...", currentToolIcon: "globe", previousToolLabel: nil,
        toolStepCount: 1, streamingText: nil,
        isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: false,
        startedAt: .now.addingTimeInterval(-5))

    static let multiTool = OpenClawActivityAttributes.ContentState(
        subject: "Updating auth module", statusText: "Editing auth.swift...",
        currentToolLabel: "Editing auth.swift...", currentToolIcon: "doc", previousToolLabel: "Searched the web",
        toolStepCount: 3, streamingText: nil,
        isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: false,
        startedAt: .now.addingTimeInterval(-18))

    static let streaming = OpenClawActivityAttributes.ContentState(
        subject: "Updating auth module", statusText: "Responding...",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: "Edited auth.swift",
        toolStepCount: 3, streamingText: "Here are the changes I made to the authentication module...",
        isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: false,
        startedAt: .now.addingTimeInterval(-25))

    static let finished = OpenClawActivityAttributes.ContentState(
        subject: "Updated auth module", statusText: "Done",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: "Edited auth.swift",
        toolStepCount: 3, streamingText: nil,
        isFinished: true, isError: false, isIdle: false, isDisconnected: false, isConnecting: false,
        startedAt: .now.addingTimeInterval(-32), endedAt: .now)

    static let error = OpenClawActivityAttributes.ContentState(
        subject: nil, statusText: "Error",
        currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
        toolStepCount: 1, streamingText: nil,
        isFinished: false, isError: true, isIdle: false, isDisconnected: false, isConnecting: false,
        startedAt: .now.addingTimeInterval(-10), endedAt: .now)
}
#endif
