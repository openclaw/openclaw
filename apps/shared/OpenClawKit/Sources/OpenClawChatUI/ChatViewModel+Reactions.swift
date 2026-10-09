import Foundation
import Observation

@MainActor
@Observable
final class ChatMessageReactionState {
    struct Target: Equatable {
        let session: OpenClawChatViewModel.SessionSnapshot
        let sessionID: String
    }

    struct WriteKey: Hashable {
        let messageID: String
        let emoji: String
    }

    struct Write {
        let key: WriteKey
        let operation: UUID
        let remove: Bool
        let message: OpenClawChatMessage
        let target: Target
        let lease: OpenClawChatReactionsRouteLease
    }

    struct WriteTail {
        let operation: UUID
        let task: Task<Void, Never>
    }

    var summaries: [String: [OpenClawChatReactionSummary]] = [:]
    var errors: [String: String] = [:]
    var writes: [WriteKey: UUID] = [:]
    @ObservationIgnored var writeTails: [String: WriteTail] = [:]
    var lease: OpenClawChatReactionsRouteLease?
    var target: Target?
    @ObservationIgnored var revisions: [String: UInt64] = [:]
    @ObservationIgnored var readUpdates: [String: [OpenClawChatReactionSummary]]?
    var refreshID = UUID()
    @ObservationIgnored var refreshTask: Task<Void, Never>?

    func reset() {
        self.refreshID = UUID()
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.target = nil
        self.lease = nil
        self.summaries = [:]
        self.errors = [:]
        self.writes = [:]
        // Queued tasks retain their predecessors; a new session must not wait on the old scope.
        self.writeTails = [:]
        self.revisions = [:]
        self.readUpdates = nil
    }
}

extension OpenClawChatViewModel {
    public var reactionContextID: UUID {
        self.reactionState.refreshID
    }

    public var viewerReactionUserID: String? {
        self.reactionState.lease?.access.userID
    }

    public func messageReactions(for message: OpenClawChatMessage) -> [OpenClawChatReactionSummary] {
        guard let target = self.reactionState.target, self.isCurrentReactionTarget(target),
              let messageID = self.savedReactionMessageID(message)
        else { return [] }
        return self.reactionState.summaries[messageID] ?? []
    }

    public func isReactionPending(for message: OpenClawChatMessage, emoji: String) -> Bool {
        message.transcriptMessageID.map {
            self.reactionState.writes[.init(messageID: $0, emoji: emoji)] != nil
        } ?? false
    }

    public func reactionError(for message: OpenClawChatMessage) -> String? {
        message.transcriptMessageID.flatMap { self.reactionState.errors[$0] }
    }

    public func canReact(to message: OpenClawChatMessage) -> Bool {
        guard self.savedReactionMessageID(message) != nil,
              self.hasCurrentSessionMetadata,
              let target = self.reactionState.target,
              self.isCurrentReactionTarget(target),
              let access = self.reactionState.lease?.access,
              let session = self.currentSessionEntry()
        else { return false }
        return access.canReact(
            sharingRole: session.sharingRole?.rawValue,
            visibility: session.visibility?.rawValue,
            archived: session.isArchived,
            catalog: OpenClawChatSessionKey.catalogSource(self.sessionKey) != nil)
    }

    public func toggleMessageReaction(message: OpenClawChatMessage, emoji: String) async {
        guard OpenClawChatReactionEmoji.isValid(emoji),
              self.canReact(to: message),
              let messageID = self.savedReactionMessageID(message),
              let target = self.reactionState.target,
              let lease = self.reactionState.lease
        else { return }
        let key = ChatMessageReactionState.WriteKey(messageID: messageID, emoji: emoji)
        guard self.reactionState.writes[key] == nil else { return }
        let remove = self.messageReactions(for: message).contains { summary in
            summary.emoji == emoji && summary.identities.contains { $0.id == lease.access.userID }
        }
        let write = ChatMessageReactionState.Write(
            key: key, operation: UUID(), remove: remove, message: message, target: target, lease: lease)
        self.reactionState.writes[key] = write.operation
        let previous = self.reactionState.writeTails[messageID]?.task
        let task = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            await self.performMessageReaction(write)
            self.finishMessageReaction(write)
        }
        self.reactionState.writeTails[messageID] = .init(operation: write.operation, task: task)
        await task.value
    }

    private func performMessageReaction(_ write: ChatMessageReactionState.Write) async {
        let messageID = write.key.messageID
        guard await write.lease.isCurrent(),
              self.isCurrentReactionWrite(write),
              self.canReact(to: write.message)
        else { return }
        self.reactionState.errors[messageID] = nil
        let revision = self.reactionState.revisions[messageID, default: 0]
        do {
            let result = try await write.lease.set(
                sessionKey: write.target.session.key,
                agentID: write.target.session.deliveryAgentID,
                messageID: messageID,
                emoji: write.key.emoji,
                remove: write.remove)
            guard await write.lease.isCurrent(),
                  self.isCurrentReactionWrite(write),
                  self.savedReactionMessageID(write.message) != nil,
                  result.messageID == messageID,
                  self.reactionState.revisions[messageID, default: 0] == revision
            else { return }
            self.reactionState.summaries[messageID] = result.reactions
            self.reactionState.readUpdates?[messageID] = result.reactions
        } catch {
            guard await write.lease.isCurrent(),
                  self.isCurrentReactionWrite(write),
                  self.savedReactionMessageID(write.message) != nil
            else { return }
            self.reactionState.errors[messageID] = error.localizedDescription
        }
    }

    private func finishMessageReaction(_ write: ChatMessageReactionState.Write) {
        if self.reactionState.writes[write.key] == write.operation {
            self.reactionState.writes[write.key] = nil
        }
        if self.reactionState.writeTails[write.key.messageID]?.operation == write.operation {
            self.reactionState.writeTails[write.key.messageID] = nil
        }
    }

    func resetSessionReactions() {
        self.reactionState.reset()
    }

    func syncSessionReactions(refreshMetadata: Bool = false) {
        guard !self.usesWebConversation, self.healthOK, !self.isTransportDetached,
              self.hasAppliedLiveHistory,
              OpenClawChatSessionKey.catalogSource(self.sessionKey) == nil,
              let sessionID = self.reactionSessionID
        else {
            self.resetSessionReactions()
            return
        }
        let target = ChatMessageReactionState.Target(session: self.currentSessionSnapshot(), sessionID: sessionID)
        guard self.historyMatchesReactionTarget(target) else {
            self.resetSessionReactions()
            return
        }
        guard self.reactionState.target != target else { return }
        self.resetSessionReactions()
        self.reactionState.target = target
        self.reactionState.readUpdates = [:]
        let refreshID = self.reactionState.refreshID
        self.reactionState.refreshTask = Task { [weak self] in
            await self?.loadSessionReactions(target, refreshID: refreshID, refreshMetadata: refreshMetadata)
        }
    }

    func handleSessionReactionEvent(_ event: OpenClawChatReactionEvent) {
        guard self.healthOK,
              self.currentSessionSnapshot().deliveryAgentID.map({
                  $0 == event.agentID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
              }) ?? true,
              self.matchesCurrentSessionKey(
                  incoming: event.sessionKey, agentId: event.agentID, current: self.sessionKey),
              event.sessionID == self.reactionSessionID,
              OpenClawChatSessionKey.catalogSource(self.sessionKey) == nil
        else { return }
        self.syncSessionReactions()
        guard let target = self.reactionState.target, self.isCurrentReactionTarget(target) else { return }
        self.reactionState.revisions[event.messageID, default: 0] &+= 1
        self.reactionState.readUpdates?[event.messageID] = event.reactions
        self.reactionState.summaries[event.messageID] = event.reactions
    }

    private var reactionSessionID: String? {
        let sessionID = self.hasCurrentSessionMetadata
            ? self.currentSessionEntry()?.sessionId ?? self.sessionId : self.sessionId
        return ChatPayloadDecoding.trimmedNonEmptyString(sessionID)
    }

    private func savedReactionMessageID(_ message: OpenClawChatMessage) -> String? {
        let role = message.role.lowercased()
        guard role == "user" || role == "assistant",
              let messageID = ChatPayloadDecoding.trimmedNonEmptyString(message.transcriptMessageID),
              self.messages.contains(where: { $0.transcriptMessageID == messageID && $0.role.lowercased() == role })
        else { return nil }
        return messageID
    }

    private func isCurrentReactionTarget(_ target: ChatMessageReactionState.Target) -> Bool {
        self.healthOK && self.isCurrentSession(target.session) &&
            self.currentSessionSnapshot().deliveryAgentID == target.session.deliveryAgentID &&
            self.reactionState.target == target && self.reactionSessionID == target.sessionID &&
            self.historyMatchesReactionTarget(target)
    }

    private func historyMatchesReactionTarget(_ target: ChatMessageReactionState.Target) -> Bool {
        self.sessionId.map { $0 == target.sessionID } ?? true
    }

    private func isCurrentReactionWrite(_ write: ChatMessageReactionState.Write) -> Bool {
        self.isCurrentReactionTarget(write.target) && self.reactionState.lease?.routeID == write.lease.routeID &&
            self.reactionState.writes[write.key] == write.operation
    }

    private func loadSessionReactions(
        _ target: ChatMessageReactionState.Target,
        refreshID: UUID,
        refreshMetadata: Bool) async
    {
        defer {
            if self.reactionState.refreshID == refreshID {
                self.reactionState.readUpdates = nil
                self.reactionState.refreshTask = nil
            }
        }
        guard let lease = await self.transport.acquireReactionsRouteLease(),
              await lease.isCurrent(),
              self.reactionState.refreshID == refreshID,
              self.isCurrentReactionTarget(target)
        else { return }
        self.reactionState.lease = lease
        if refreshMetadata, !self.hasCurrentSessionMetadata {
            await self.fetchSessions(limit: Self.sessionListFetchLimit, sessionSnapshot: target.session)
        }
        guard self.isCurrentReactionTarget(target), lease.access.canList else { return }
        do {
            let result = try await lease.list(sessionKey: target.session.key, agentID: target.session.deliveryAgentID)
            guard await lease.isCurrent(),
                  self.reactionState.refreshID == refreshID,
                  self.isCurrentReactionTarget(target),
                  self.reactionState.lease?.routeID == lease.routeID,
                  result.sessionID == target.sessionID
            else { return }
            // Events committed after the read began outrank its older snapshot.
            let merged = result.reactions.merging(self.reactionState.readUpdates ?? [:]) { _, new in new }
            // The snapshot also supersedes pending writes for messages it omits.
            let messageIDs = Set(self.reactionState.summaries.keys).union(merged.keys)
                .union(self.reactionState.writes.keys.map(\.messageID))
            for messageID in messageIDs {
                self.reactionState.revisions[messageID, default: 0] &+= 1
            }
            self.reactionState.summaries = merged
        } catch {
            guard await lease.isCurrent(),
                  self.reactionState.refreshID == refreshID,
                  self.isCurrentReactionTarget(target)
            else { return }
            self.errorText = error.localizedDescription
        }
    }
}
