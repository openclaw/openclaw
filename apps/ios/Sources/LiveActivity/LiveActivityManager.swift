@preconcurrency import ActivityKit
import Foundation
import os

/// Minimal Live Activity lifecycle focused on connection health + stale cleanup.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "LiveActivity")
    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var activityStartDate: Date = .now

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
            self.logger.info("started live activity id=\(activity.id, privacy: .public)")
        } catch {
            self.logger.error("failed to start live activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    func handleConnecting() {
        self.updateCurrent(state: self.connectingState())
    }

    func handleReconnect() {
        self.updateCurrent(state: self.idleState())
    }

    func handleDisconnect() {
        self.updateCurrent(state: self.disconnectedState())
    }

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
            startedAt: self.activityStartDate)
    }

    private func idleState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Idle",
            isIdle: true,
            isDisconnected: false,
            isConnecting: false,
            startedAt: self.activityStartDate)
    }

    private func disconnectedState() -> OpenClawActivityAttributes.ContentState {
        OpenClawActivityAttributes.ContentState(
            statusText: "Disconnected",
            isIdle: false,
            isDisconnected: true,
            isConnecting: false,
            startedAt: self.activityStartDate)
    }
}
