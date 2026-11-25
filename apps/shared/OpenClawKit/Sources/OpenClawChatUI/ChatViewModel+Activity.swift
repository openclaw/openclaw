import Foundation
import OpenClawProtocol

extension OpenClawChatViewModel {
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
            // PRs wait on their board; the rules already place them after progress.
            pullRequests: nil)
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
