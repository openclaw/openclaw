import SwiftUI

@main
struct OpenClawWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var inboxStore = WatchInboxStore()
    @State private var receiver: WatchConnectivityReceiver?
    @State private var execApprovalRefreshTask: Task<Void, Never>?

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
                },
                onRefreshAppSnapshot: {
                    self.refreshAppSnapshot()
                },
                onAppCommand: { command in
                    self.sendAppCommand(command)
                },
                onSendChatMessage: { text in
                    self.sendChatMessage(text)
                })
                .task {
                    if self.receiver == nil {
                        let receiver = WatchConnectivityReceiver(store: self.inboxStore)
                        receiver.activate()
                        self.receiver = receiver
                    }
                    self.refreshAppSnapshot()
                    self.refreshExecApprovalReview()
                }
                .onChange(of: self.scenePhase) { _, newPhase in
                    guard newPhase == .active else { return }
                    self.refreshAppSnapshot()
                    self.refreshExecApprovalReview()
                }
        }
    }

    private func refreshAppSnapshot() {
        guard let receiver else { return }
        self.inboxStore.markAppSnapshotRequestStarted()
        Task { @MainActor in
            let result = await receiver.requestAppSnapshot()
            self.inboxStore.markAppSnapshotRequestResult(result)
        }
    }

    private func sendAppCommand(_ command: WatchAppCommand) {
        guard let receiver else { return }
        let message = self.inboxStore.makeAppCommand(command)
        self.inboxStore.markAppCommandSending(command)
        Task { @MainActor in
            let result = await receiver.sendAppCommand(message)
            self.inboxStore.markAppCommandResult(result, command: command)
        }
    }

    private func sendChatMessage(_ text: String) {
        guard let receiver else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = self.inboxStore.makeAppCommand(.sendChat, text: trimmed)
        self.inboxStore.markAppCommandSending(.sendChat)
        Task { @MainActor in
            let result = await receiver.sendAppCommand(message)
            self.inboxStore.markAppCommandResult(result, command: .sendChat)
            try? await Task.sleep(nanoseconds: 900_000_000)
            self.refreshAppSnapshot()
        }
    }

    private func refreshExecApprovalReview(force: Bool = false) {
        guard let receiver else { return }
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
