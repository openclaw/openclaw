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

@MainActor
final class WatchChatCoordinator {
    enum Decision {
        case dropMissingFields
        case dropMissingTarget
        case deduped(commandId: String)
        case queue(commandId: String)
        case forward
    }

    private static let persistedQueueKey = "watch.chat.command.queue.v1"
    private static let maxRecentCommandIds = 128

    private struct QueuedCommand: Codable, Equatable {
        var gatewayStableID: String
        var event: WatchAppCommandEvent
    }

    private let defaults: UserDefaults
    private var queuedCommands: [QueuedCommand] = []
    private var recentCommandIds: [String] = []
    private var seenCommandIds = Set<String>()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.restoreQueue()
    }

    func ingest(
        _ event: WatchAppCommandEvent,
        isChatAvailable: Bool,
        gatewayStableID: String?) -> Decision
    {
        let commandId = event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if commandId.isEmpty || text.isEmpty {
            return .dropMissingFields
        }
        if self.seenCommandIds.contains(commandId) {
            return .deduped(commandId: commandId)
        }
        self.rememberRecentCommandId(commandId)
        if !isChatAvailable {
            let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !owner.isEmpty else { return .dropMissingTarget }
            self.queuedCommands.append(
                QueuedCommand(gatewayStableID: owner, event: self.command(event, taggedFor: owner)))
            self.rebuildSeenCommandIds()
            self.persistQueue()
            return .queue(commandId: commandId)
        }
        return .forward
    }

    func nextQueuedCommand(isChatAvailable: Bool, gatewayStableID: String?) -> WatchAppCommandEvent? {
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard isChatAvailable, !owner.isEmpty else { return nil }
        return self.queuedCommands.first { $0.gatewayStableID == owner }?.event
    }

    func removeQueuedCommand(commandId: String, gatewayStableID: String?) {
        let commandId = commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !commandId.isEmpty, !owner.isEmpty else { return }
        guard let index = self.queuedCommands.firstIndex(where: {
            $0.gatewayStableID == owner && $0.event.commandId == commandId
        }) else { return }
        self.queuedCommands.remove(at: index)
        self.rememberRecentCommandId(commandId)
        self.persistQueue()
    }

    func requeueFront(_ event: WatchAppCommandEvent, gatewayStableID: String?) {
        let commandId = event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !owner.isEmpty else { return }
        if !commandId.isEmpty {
            self.rememberRecentCommandId(commandId)
            self.queuedCommands.removeAll { $0.event.commandId == commandId }
        }
        self.queuedCommands.insert(
            QueuedCommand(gatewayStableID: owner, event: self.command(event, taggedFor: owner)),
            at: 0)
        self.rebuildSeenCommandIds()
        self.persistQueue()
    }

    var queuedCount: Int {
        self.queuedCommands.count
    }

    var queuedCommandIds: [String] {
        self.queuedCommands.map(\.event.commandId)
    }

    private func restoreQueue() {
        guard let data = defaults.data(forKey: Self.persistedQueueKey),
              let persisted = try? JSONDecoder().decode([QueuedCommand].self, from: data)
        else {
            return
        }

        var seen: [String] = []
        var seenSet = Set<String>()
        self.queuedCommands = persisted.compactMap { queued in
            let owner = queued.gatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
            let commandId = queued.event.commandId.trimmingCharacters(in: .whitespacesAndNewlines)
            let text = queued.event.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !owner.isEmpty, !commandId.isEmpty, !text.isEmpty, seenSet.insert(commandId).inserted else {
                return nil
            }
            seen.append(commandId)
            return QueuedCommand(gatewayStableID: owner, event: self.command(queued.event, taggedFor: owner))
        }
        self.recentCommandIds = Array(seen.suffix(Self.maxRecentCommandIds))
        self.rebuildSeenCommandIds()
        if self.queuedCommands.count != persisted.count {
            self.persistQueue()
        }
    }

    private func rememberRecentCommandId(_ commandId: String) {
        guard !commandId.isEmpty else { return }
        self.recentCommandIds.removeAll { $0 == commandId }
        self.recentCommandIds.append(commandId)
        if self.recentCommandIds.count > Self.maxRecentCommandIds {
            self.recentCommandIds.removeFirst(self.recentCommandIds.count - Self.maxRecentCommandIds)
        }
        self.rebuildSeenCommandIds()
    }

    private func rebuildSeenCommandIds() {
        var ids = Set(self.recentCommandIds)
        ids.formUnion(self.queuedCommands.map(\.event.commandId))
        self.seenCommandIds = ids
    }

    private func persistQueue() {
        if self.queuedCommands.isEmpty {
            self.defaults.removeObject(forKey: Self.persistedQueueKey)
            return
        }
        guard let data = try? JSONEncoder().encode(queuedCommands) else { return }
        self.defaults.set(data, forKey: Self.persistedQueueKey)
    }

    private func command(_ event: WatchAppCommandEvent, taggedFor gatewayStableID: String) -> WatchAppCommandEvent {
        var tagged = event
        tagged.gatewayStableID = gatewayStableID
        return tagged
    }

    static func resetPersistedQueue(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: self.persistedQueueKey)
    }
}
