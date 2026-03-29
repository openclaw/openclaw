import Foundation

@MainActor
final class WatchReplyCoordinator {
    enum Decision {
        case dropMissingFields
        case deduped(replyId: String)
        case queue(replyId: String, actionId: String)
        case forward
    }

    private var queuedReplies: [WatchQuickReplyEvent] = []
    private var seenReplyIds = Set<String>()

    func ingest(_ event: WatchQuickReplyEvent, isGatewayConnected: Bool) -> Decision {
        let replyId = event.replyId.trimmingCharacters(in: .whitespacesAndNewlines)
        let actionId = event.actionId.trimmingCharacters(in: .whitespacesAndNewlines)
        if replyId.isEmpty || actionId.isEmpty {
            return .dropMissingFields
        }
        if self.seenReplyIds.contains(replyId) {
            return .deduped(replyId: replyId)
        }
        self.seenReplyIds.insert(replyId)
        if !isGatewayConnected {
            self.queuedReplies.append(event)
            return .queue(replyId: replyId, actionId: actionId)
        }
        return .forward
    }

    func drainIfConnected(_ isGatewayConnected: Bool) -> [WatchQuickReplyEvent] {
        guard isGatewayConnected, !self.queuedReplies.isEmpty else { return [] }
        let pending = self.queuedReplies
        self.queuedReplies.removeAll()
        return pending
    }

    func requeueFront(_ event: WatchQuickReplyEvent) {
        self.queuedReplies.insert(event, at: 0)
    }

    var queuedCount: Int {
        self.queuedReplies.count
    }
}
