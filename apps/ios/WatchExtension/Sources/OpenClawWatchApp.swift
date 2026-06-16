import SwiftUI

@main
struct OpenClawWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var inboxStore = WatchInboxStore(
        requestNotificationAuthorization: !OpenClawWatchApp.isScreenshotMode)
    @State private var receiver: WatchConnectivityReceiver?
    @State private var execApprovalRefreshTask: Task<Void, Never>?

    private static let screenshotModeDefaultsKey = "openclaw.watch.screenshotMode"
    private static let isScreenshotMode = ProcessInfo.processInfo.arguments.contains(
        "--openclaw-watch-screenshot-mode")
        || ProcessInfo.processInfo.environment["OPENCLAW_WATCH_SCREENSHOT_MODE"] == "1"
        || UserDefaults.standard.bool(forKey: OpenClawWatchApp.screenshotModeDefaultsKey)

    var body: some Scene {
        WindowGroup {
            WatchInboxView(
                store: self.inboxStore,
                onAction: { action in
                    guard let receiver = self.receiver else { return }
                    let draft = self.inboxStore.makeReplyDraft(action: action)
                    self.inboxStore.markReplySending(actionLabel: action.label)
                    Task { @MainActor in
                        let result = await receiver.sendReply(draft)
                        self.inboxStore.markReplyResult(result, actionLabel: action.label)
                    }
                },
                onExecApprovalDecision: { approvalId, decision in
                    guard let receiver = self.receiver else { return }
                    self.inboxStore.markExecApprovalSending(approvalId: approvalId, decision: decision)
                    Task { @MainActor in
                        let result = await receiver.sendExecApprovalResolve(
                            approvalId: approvalId,
                            decision: decision)
                        self.inboxStore.markExecApprovalSendResult(
                            approvalId: approvalId,
                            decision: decision,
                            result: result)
                    }
                },
                onRefreshExecApprovalReview: {
                    self.refreshExecApprovalReview(force: true)
                })
                .task {
                    if OpenClawWatchApp.isScreenshotMode {
                        self.inboxStore.configureScreenshotFixture()
                        return
                    }
                    if self.receiver == nil {
                        let receiver = WatchConnectivityReceiver(store: self.inboxStore)
                        receiver.activate()
                        self.receiver = receiver
                    }
                    self.refreshExecApprovalReview()
                }
                .onChange(of: self.scenePhase) { _, newPhase in
                    guard newPhase == .active else { return }
                    self.refreshExecApprovalReview()
                }
        }
    }

    private func refreshExecApprovalReview(force: Bool = false) {
        guard let receiver = self.receiver else { return }
        guard force || self.inboxStore.shouldAutoRequestExecApprovalSnapshot else { return }

        self.execApprovalRefreshTask?.cancel()
        self.execApprovalRefreshTask = Task { @MainActor in
            self.inboxStore.beginExecApprovalReviewLoading()
            for attempt in 0..<5 {
                if Task.isCancelled { return }
                await receiver.requestExecApprovalSnapshot()
                if !self.inboxStore.execApprovals.isEmpty
                    || self.inboxStore.hasCompletedExecApprovalSnapshotRefresh
                {
                    self.inboxStore.markExecApprovalReviewLoaded()
                    return
                }
                if attempt < 4 {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                }
            }
            if self.inboxStore.execApprovals.isEmpty {
                self.inboxStore.markExecApprovalReviewUnavailable(
                    "Couldn't load approval from your iPhone yet.")
            }
        }
    }
}

@MainActor
extension WatchInboxStore {
    fileprivate func configureScreenshotFixture() {
        self.consume(
            execApprovalSnapshot: WatchExecApprovalSnapshotMessage(
                approvals: [],
                sentAtMs: Int(Date().timeIntervalSince1970 * 1000),
                snapshotId: nil),
            transport: "screenshot")
        self.consume(
            message: WatchNotifyMessage(
                id: "watch-screenshot-quick-reply",
                title: "Molty request",
                body: "Molty Gateway checklist ready.",
                sentAtMs: Int(Date().timeIntervalSince1970 * 1000),
                promptId: "watch-screenshot-prompt",
                sessionKey: "watch-screenshot-session",
                kind: "release-checklist",
                details: nil,
                expiresAtMs: nil,
                risk: "medium",
                actions: [
                    WatchPromptAction(id: "approve", label: "Approve", style: nil),
                    WatchPromptAction(id: "later", label: "Later", style: "cancel"),
                ]),
            transport: "screenshot")
    }
}
