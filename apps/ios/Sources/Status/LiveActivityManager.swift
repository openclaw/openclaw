import ActivityKit
import Foundation
import os

@available(iOS 16.1, *)
private struct GatewayLiveActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum ConnectionState: String, Codable, Hashable {
            case connecting
            case connected
        }

        var connectionState: ConnectionState
        var agentName: String
        var sessionKey: String
        var updatedAt: Date
    }

    var startedAt: Date
}

@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "LiveActivity")
    private var currentAgentName = "main"
    private var currentSessionKey = "main"

    private init() {}

    var isActive: Bool {
        guard #available(iOS 16.1, *) else { return false }
        return !Activity<GatewayLiveActivityAttributes>.activities.isEmpty
    }

    func startActivity(agentName: String, sessionKey: String) {
        self.currentAgentName = agentName
        self.currentSessionKey = sessionKey
        self.ensureActivityStarted(state: .connecting)
    }

    func handleConnecting() {
        self.ensureActivityStarted(state: .connecting)
    }

    func handleReconnect() {
        self.ensureActivityStarted(state: .connected)
    }

    func handleDisconnect() {
        guard #available(iOS 16.1, *) else { return }
        let activities = Activity<GatewayLiveActivityAttributes>.activities
        guard !activities.isEmpty else { return }

        Task {
            for activity in activities {
                if #available(iOS 16.2, *) {
                    let finalState = GatewayLiveActivityAttributes.ContentState(
                        connectionState: .connected,
                        agentName: self.currentAgentName,
                        sessionKey: self.currentSessionKey,
                        updatedAt: Date())
                    let content = ActivityContent(state: finalState, staleDate: Date())
                    await activity.end(content, dismissalPolicy: .immediate)
                } else {
                    let finalState = GatewayLiveActivityAttributes.ContentState(
                        connectionState: .connected,
                        agentName: self.currentAgentName,
                        sessionKey: self.currentSessionKey,
                        updatedAt: Date())
                    await activity.end(using: finalState, dismissalPolicy: .immediate)
                }
            }
        }
    }
}

private extension LiveActivityManager {
    func ensureActivityStarted(state: GatewayLiveActivityAttributes.ContentState.ConnectionState) {
        guard #available(iOS 16.1, *) else { return }

        if let activity = Activity<GatewayLiveActivityAttributes>.activities.first {
            self.update(activity: activity, state: state)
            return
        }

        let attributes = GatewayLiveActivityAttributes(startedAt: Date())
        let contentState = GatewayLiveActivityAttributes.ContentState(
            connectionState: state,
            agentName: self.currentAgentName,
            sessionKey: self.currentSessionKey,
            updatedAt: Date())

        Task {
            do {
                if #available(iOS 16.2, *) {
                    let content = ActivityContent(state: contentState, staleDate: nil)
                    _ = try Activity<GatewayLiveActivityAttributes>.request(
                        attributes: attributes,
                        content: content,
                        pushType: nil)
                } else {
                    _ = try Activity<GatewayLiveActivityAttributes>.request(
                        attributes: attributes,
                        contentState: contentState,
                        pushType: nil)
                }
            } catch {
                self.logger.error("failed to start live activity: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    func update(
        activity: Activity<GatewayLiveActivityAttributes>,
        state: GatewayLiveActivityAttributes.ContentState.ConnectionState)
    {
        guard #available(iOS 16.1, *) else { return }
        let contentState = GatewayLiveActivityAttributes.ContentState(
            connectionState: state,
            agentName: self.currentAgentName,
            sessionKey: self.currentSessionKey,
            updatedAt: Date())

        Task {
            if #available(iOS 16.2, *) {
                let content = ActivityContent(state: contentState, staleDate: nil)
                await activity.update(content)
            } else {
                await activity.update(using: contentState)
            }
        }
    }
}
