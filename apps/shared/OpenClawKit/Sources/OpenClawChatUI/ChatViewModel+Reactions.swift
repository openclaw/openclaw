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

    var summaries: [String: [OpenClawChatReactionSummary]] = [:]
    var errors: [String: String] = [:]
    var writes: Set<WriteKey> = []
    @ObservationIgnored var writeTails: [String: Task<Void, Never>] = [:]
    var lease: OpenClawChatReactionsRouteLease?
    var target: Target?
    @ObservationIgnored var revisions: [String: UInt64] = [:]
    @ObservationIgnored var readUpdates: [String: [OpenClawChatReactionSummary]]?
    let refreshID = UUID()
    @ObservationIgnored var refreshTask: Task<Void, Never>?
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
            self.reactionState.writes.contains(.init(messageID: $0, emoji: emoji))
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
        let state = self.reactionState
        let key = ChatMessageReactionState.WriteKey(messageID: messageID, emoji: emoji)
        guard state.writes.insert(key).inserted else { return }
        let remove = self.messageReactions(for: message).contains { summary in
            summary.emoji == emoji && summary.identities.contains { $0.id == lease.access.userID }
        }
        let previous = state.writeTails[messageID]
        let task = Task { [weak self] in
            defer {
                state.writes.remove(key)
                if !state.writes.contains(where: { $0.messageID == messageID }) {
                    state.writeTails[messageID] = nil
                }
            }
            await previous?.value
            guard let self, await lease.isCurrent(), self.reactionState === state, self.canReact(to: message)
            else { return }
            state.errors[messageID] = nil
            let revision = state.revisions[messageID, default: 0]
            do {
                let result = try await lease.set(
                    sessionKey: target.session.key,
                    agentID: target.session.deliveryAgentID,
                    messageID: messageID,
                    emoji: emoji,
                    remove: remove)
                guard self.reactionState === state,
                      self.isCurrentReactionTarget(target),
                      self.savedReactionMessageID(message) != nil,
                      result.messageID == messageID,
                      state.revisions[messageID, default: 0] == revision
                else { return }
                state.summaries[messageID] = result.reactions
                state.readUpdates?[messageID] = result.reactions
            } catch {
                guard await lease.isCurrent(), self.reactionState === state,
                      self.isCurrentReactionTarget(target), self.savedReactionMessageID(message) != nil
                else { return }
                state.errors[messageID] = error.localizedDescription
            }
        }
        state.writeTails[messageID] = task
        await task.value
    }

    func resetSessionReactions() {
        self.reactionState.refreshTask?.cancel()
        // Pending work keeps its old context; it cannot clear a new session's pending state.
        self.reactionState = ChatMessageReactionState()
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
        let state = self.reactionState
        state.refreshTask = Task { [weak self] in
            await self?.loadSessionReactions(target, state: state, refreshMetadata: refreshMetadata)
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

    private func loadSessionReactions(
        _ target: ChatMessageReactionState.Target,
        state: ChatMessageReactionState,
        refreshMetadata: Bool) async
    {
        defer {
            state.readUpdates = nil
            state.refreshTask = nil
        }
        guard let lease = await self.transport.acquireReactionsRouteLease(),
              await lease.isCurrent(),
              self.reactionState === state,
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
                  self.reactionState === state,
                  self.isCurrentReactionTarget(target),
                  result.sessionID == target.sessionID
            else { return }
            // Events committed after the read began outrank its older snapshot.
            let merged = result.reactions.merging(self.reactionState.readUpdates ?? [:]) { _, new in new }
            // The snapshot also supersedes pending writes for messages it omits.
            let messageIDs = Set(self.reactionState.summaries.keys).union(merged.keys)
                .union(self.reactionState.writes.map(\.messageID))
            for messageID in messageIDs {
                self.reactionState.revisions[messageID, default: 0] &+= 1
            }
            self.reactionState.summaries = merged
        } catch {
            guard await lease.isCurrent(),
                  self.reactionState === state,
                  self.isCurrentReactionTarget(target)
            else { return }
            self.errorText = error.localizedDescription
        }
    }
}
