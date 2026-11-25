import Foundation
import OpenClawProtocol

extension OpenClawChatViewModel {
    /// Watches the current chat's PRs. One watch per key per connection; the transport says when it has no feed.
    func watchSessionPullRequests() {
        let key = self.sessionKey
        guard self.pullRequestWatchKey != key else { return }
        self.pullRequestWatchTask?.cancel()
        let transport = self.transport
        self.pullRequestWatchTask = Task { [weak self] in
            let watched = try? await transport.watchSessionPullRequests(sessionKeys: [key])
            guard let self, !Task.isCancelled, self.sessionKey == key else { return }
            // Nil is a transport without the feed; false is a Gateway that declined. Neither shows a PR.
            self.pullRequestWatchKey = watched == true ? key : nil
            if watched == nil, self.sessionPullRequests?.key == key { self.sessionPullRequests = nil }
        }
    }

    func handleSessionPullRequestsChanged(_ event: OpenClawSessionPullRequestsChangedEvent) {
        // Another owner on this connection (the Mac's hover cards) may watch other keys.
        guard let watched = self.pullRequestWatchKey, watched == self.sessionKey else { return }
        guard let snapshot = event.sessions.first(where: { incoming, _ in
            self.matchesCurrentSessionKey(incoming: incoming, agentId: nil, current: watched)
        })?.value else { return }
        let previous = self.sessionPullRequests?.key == watched ? self.sessionPullRequests?.snapshot : nil
        self.sessionPullRequests = (watched, snapshot.retaining(previous))
    }

    /// What the activity row above the composer reads. The approval card's presence comes from the view.
    func activityInput(approvalPending: Bool, showsProgress: Bool) -> ChatActivityInput {
        let session = self.currentSessionEntry()
        let card = showsProgress ? self.progressCard : nil
        return ChatActivityInput(
            approvalPending: approvalPending,
            children: ChatActivityChild.children(of: session, in: self.sessions),
            goal: session?.goal,
            plan: card.map { card in
                ChatActivityPlan(
                    steps: card.steps ?? [],
                    note: card.markdown,
                    runActive: self.hasBlockingRunActivity,
                    sessionStatus: session?.status,
                    refreshPending: self.progressCardRefreshPending)
            },
            pullRequests: self.sessionPullRequests?.key == self.sessionKey ? self.sessionPullRequests?.snapshot : nil)
    }

    /// A child's order and latest reply, through the transcript's own decoding and visible-text rules.
    func loadActivityChildTranscript(sessionKey: String) async throws -> ChatActivityChildTranscript {
        let history = try await self.transport.requestHistory(sessionKey: sessionKey)
        let messages = await Self.decodeMessages(history.messages ?? [], activity: history.activity)
        return ChatActivityChildTranscript(messages: messages)
    }
}

struct ChatActivityChildTranscript: Equatable {
    let order: String?
    let latestReply: String?

    init(order: String?, latestReply: String?) {
        self.order = order
        self.latestReply = latestReply
    }

    /// The order is what the child was first asked; the reply is its latest visible answer.
    init(messages: [OpenClawChatMessage]) {
        func text(_ message: OpenClawChatMessage, role: String) -> String? {
            guard message.role.lowercased() == role else { return nil }
            let text = ChatMessageVisibleText.visibleText(in: message).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        self.order = messages.lazy.compactMap { text($0, role: "user") }.first
        self.latestReply = messages.reversed().lazy.compactMap { text($0, role: "assistant") }.first
    }
}
