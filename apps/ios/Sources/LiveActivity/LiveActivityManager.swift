import ActivityKit
import Foundation
import os

/// Minimal Live Activity lifecycle focused on connection health + stale cleanup.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "LiveActivity")
    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var activityStartDate: Date = .now

    /// Tracks the last known non-working connection state so `handleWorking(nil)`
    /// restores the correct state rather than blindly resetting to idle.
    private enum ConnectionState { case idle, connecting, disconnected }
    private var lastConnectionState: ConnectionState = .idle

    private init() {
        self.hydrateCurrentAndPruneDuplicates()
    }

    var isActive: Bool {
        guard let activity = self.currentActivity else { return false }
        guard activity.activityState == .active else {
            self.currentActivity = nil
            return false
        }
        return true
    }

    func startActivity(agentName: String, sessionKey: String) {
        self.hydrateCurrentAndPruneDuplicates()

        if self.currentActivity != nil {
            self.handleConnecting()
            return
        }

        let authInfo = ActivityAuthorizationInfo()
        guard authInfo.areActivitiesEnabled else {
            self.logger.info("Live Activities disabled; skipping start")
            return
        }

        self.activityStartDate = .now
        let attributes = OpenClawActivityAttributes(agentName: agentName, sessionKey: sessionKey)

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: self.connectingState(), staleDate: nil),
                pushType: nil)
            self.currentActivity = activity
            self.lastConnectionState = .connecting
            self.logger.info("started live activity id=\(activity.id, privacy: .public)")
        } catch {
            self.logger.error("failed to start live activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    func handleConnecting() {
        self.lastConnectionState = .connecting
        self.updateCurrent(state: self.connectingState())
    }

    func handleReconnect() {
        self.lastConnectionState = .idle
        self.updateCurrent(state: self.idleState())
    }

    func handleDisconnect() {
        self.lastConnectionState = .disconnected
        self.updateCurrent(state: self.disconnectedState())
    }

    /// Call when the agent begins processing a task.
    /// - Parameter task: Short human-readable description (e.g. "Building iOS app…").
    ///   Pass `nil` to complete the task and restore the previous connection state.
    func handleWorking(task: String?) {
        if let task {
            self.updateCurrent(state: self.workingState(task: task))
            self.logger.info("live activity → working task=\(task, privacy: .public)")
        } else {
            // Restore the last known connection state rather than blindly going to idle.
            // This prevents overwriting a disconnected/connecting state if the connection
            // changed while the task was running.
            let restored: OpenClawActivityAttributes.ContentState
            switch self.lastConnectionState {
            case .idle:        restored = self.idleState()
            case .connecting:  restored = self.connectingState()
            case .disconnected: restored = self.disconnectedState()
            }
            self.updateCurrent(state: restored)
            self.logger.info("live activity → \(String(describing: self.lastConnectionState)) (task completed)")
        }
    }

    // MARK: - Private helpers

    private func hydrateCurrentAndPruneDuplicates() {
        let active = Activity<OpenClawActivityAttributes>.activities
        guard !active.isEmpty else {
            self.currentActivity = nil
            return
        }

        let keeper = active.max { lhs, rhs in
            lhs.content.state.startedAt < rhs.content.state.startedAt
        } ?? active[0]

        self.currentActivity = keeper
        self.activityStartDate = keeper.content.state.startedAt
        // Restore lastConnectionState from the hydrated state so handleWorking(nil)
        // reverts to the correct state after an app restart.
        let s = keeper.content.state
        if s.isDisconnected       { self.lastConnectionState = .disconnected }
        else if s.isConnecting    { self.lastConnectionState = .connecting }
        else                      { self.lastConnectionState = .idle }

        let stale = active.filter { $0.id != keeper.id }
        for activity in stale {
            Task {
                await activity.end(
                    ActivityContent(state: self.disconnectedState(), staleDate: nil),
                    dismissalPolicy: .immediate)
            }
        }
    }

    private func updateCurrent(state: OpenClawActivityAttributes.ContentState) {
        guard let activity = self.currentActivity else { return }
        Task {
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
    }

    private func connectingState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Connecting...",
            isIdle: false,
            isDisconnected: false,
            isConnecting: true,
            isWorking: false,
            taskDescription: nil,
            startedAt: self.activityStartDate)
    }

    private func idleState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Connected",
            isIdle: true,
            isDisconnected: false,
            isConnecting: false,
            isWorking: false,
            taskDescription: nil,
            startedAt: self.activityStartDate)
    }

    private func disconnectedState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Disconnected",
            isIdle: false,
            isDisconnected: true,
            isConnecting: false,
            isWorking: false,
            taskDescription: nil,
            startedAt: self.activityStartDate)
    }

    private func workingState(task: String) -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: task,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            isWorking: true,
            taskDescription: task,
            // Use `.now` so the elapsed-time timer in the Dynamic Island measures
            // task duration, not time since the Live Activity was created.
            startedAt: .now)
    }
}
