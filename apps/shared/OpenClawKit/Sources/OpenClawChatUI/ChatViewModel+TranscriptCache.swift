import Foundation

// Offline transcript cache integration. The cache only pre-paints cold opens
// and covers offline browsing; live gateway responses are always the source
// of truth and replace cached rows wholesale.

extension OpenClawChatViewModel {
    func appendMessage(_ message: OpenClawChatMessage) {
        self.messages.append(message)
        self.markTimelineChanged()
    }

    func removeMessage(id: UUID) {
        let previousCount = self.messages.count
        self.messages.removeAll { $0.id == id }
        if self.messages.count != previousCount {
            self.markTimelineChanged()
        }
    }

    struct SessionSnapshot: Equatable {
        var key: String
        var generation: UInt64
        var agentID: String?
        var deliveryAgentID: String?
        var sessionRoutingContract: String?
    }

    func replaceMessages(_ messages: [OpenClawChatMessage], narrationSettled: Bool = false) {
        // Do not publish a narration mutation for an unchanged history response.
        var narration = self.narration
        let reconciled = narration.reconcile(messages, settled: narrationSettled)
        if reconciled.changed { self.narration = narration }
        guard self.messages != reconciled.messages || reconciled.changed else { return }
        self.retireStreamingSource(for: reconciled.messages)
        self.messages = reconciled.messages
        self.seedInputHistory(from: reconciled.messages)
        self.markTimelineChanged()
    }

    /// Consume each fresh owned final once: a history refresh must not retire a later follow-up.
    func retireStreamingSource(for messages: [OpenClawChatMessage]) {
        guard let runID = self.streamingAssistantRunID, let raw = self.streamingAssistantText else { return }
        let boundary = messages.lastIndex { self.streamingPriorMessageIDs.contains($0.id) }
        guard self.streamingPriorMessageIDs.isEmpty || boundary != nil else { return }
        let start = boundary.map { messages.index(after: $0) } ?? messages.startIndex
        for message in messages[start...] where message.isCompletedReply &&
            (message.workRunID == runID || self.provisionalFinalMessagesByID[message.id]?.runId == runID)
        {
            guard self.streamingRetiredFinalIDs.insert(message.id).inserted else { continue }
            self.streamingRetiredSource = (message.id, raw, self.displayedStreamingAssistantTextUntracked)
        }
    }

    var liveAssistantDisplayText: String? {
        self.liveText(self.displayedStreamingAssistantText)
    }

    /// A structural read must not subscribe the whole transcript to every new word.
    var liveAssistantTextShape: String? {
        _ = self.liveTextShape
        return self.liveText(self.displayedStreamingAssistantTextUntracked)
    }

    var hasStreamingAssistantText: Bool {
        _ = self.liveTextShape
        return self.displayedStreamingAssistantTextUntracked != nil
    }

    func streamingTextShape(_ text: String?) -> [Bool] {
        let live = self.liveText(text)
        return [text != nil] + [true, false].map { thinking in
            live.map { AssistantTextParser.hasVisibleContent(in: $0, includeThinking: thinking) } ?? false
        }
    }

    func liveText(_ streaming: String?) -> String? {
        guard let text = streaming else { return nil }
        let live = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !live.isEmpty else { return text }
        // Exact recorded text also covers narration and durable-before-stream delivery.
        // Only the partial-prefix case below needs a newly arrived completed reply.
        let exact = self.transcriptMessages.reversed().prefix { $0.role.lowercased() != "user" }.contains {
            $0.role.lowercased() == "assistant" && $0.rawText == live &&
                (self.streamingAssistantRunID == nil || $0.workRunID == nil ||
                    $0.workRunID == self.streamingAssistantRunID)
        }
        if exact { return nil }
        if let retired = self.streamingRetiredSource,
           self.messages.contains(where: { $0.id == retired.finalID && $0.isCompletedReply }),
           retired.raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(live) ||
           retired.displayed?.trimmingCharacters(in: .whitespacesAndNewlines) == live
        {
            return nil
        }
        if let runID = self.streamingAssistantRunID {
            // Durable output may overtake the display pacer. Run ownership, not
            // equality with its partial string, identifies the superseded copy.
            // Exclude existing rows so a reused run ID cannot hide a new answer.
            let boundary = self.messages.lastIndex { self.streamingPriorMessageIDs.contains($0.id) }
            guard self.streamingPriorMessageIDs.isEmpty || boundary != nil else { return text }
            let start = boundary.map { self.messages.index(after: $0) } ?? self.messages.startIndex
            let recorded = self.messages[start...].contains { message in
                message.isCompletedReply && message.rawText.hasPrefix(live) &&
                    (message.workRunID == runID || self.provisionalFinalMessagesByID[message.id]?.runId == runID)
            }
            return recorded ? nil : text
        }
        return text
    }

    nonisolated static func durableSessionCacheProjection(
        _ session: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry
    {
        var projected = session
        let wasActive =
            projected.hasActiveRun == true ||
            projected.activeRunIds?.isEmpty == false ||
            projected.hasActiveSubagentRun == true ||
            projected.status?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "running"
        projected.hasActiveRun = nil
        projected.activeRunIds = nil
        projected.hasActiveSubagentRun = nil
        if wasActive {
            projected.startedAt = nil
            projected.status = nil
        }
        return projected
    }

    func persistTranscriptToCache(
        session: SessionSnapshot,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys: Set<String>)
    {
        let transcriptCache = self.transcriptCache
        let outbox = self.outbox
        let scope = self.outboxBranchScope(for: session)
        let tip = messages.reversed().compactMap {
            ChatPayloadDecoding.trimmedNonEmptyString($0.transcriptMessageID)
        }.first
        guard transcriptCache != nil || (outbox != nil && scope != nil && tip != nil) else { return }
        let branchStateTask: Task<OpenClawChatOutboxBranchState?, Never>? = if let outbox, let scope {
            Task { await outbox.branchState(for: scope) }
        } else {
            nil
        }
        // Chain writes so an older snapshot can never land after a newer one;
        // detached tasks alone give no ordering guarantee across awaits.
        let previous = pendingCacheWriteTask
        pendingCacheWriteTask = Task.detached {
            await previous?.value
            if let transcriptCache {
                await transcriptCache.storeCanonicalTranscript(
                    sessionKey: session.key,
                    agentID: Self.transcriptCacheAgentID(sessionKey: session.key, agentID: session.deliveryAgentID),
                    messages: messages,
                    canonicalMessageIdempotencyKeys: canonicalMessageIdempotencyKeys)
            }
            if let outbox,
               let scope,
               let tip,
               let branchStateTask,
               let expectedEpoch = await branchStateTask.value?.epoch
            {
                _ = await outbox.updateLastActiveLeafEntryID(
                    tip,
                    expectedEpoch: expectedEpoch,
                    for: scope)
            }
        }
    }

    func persistSessionsToCache(_ sessions: [OpenClawChatSessionEntry], agentID: String?) {
        guard let transcriptCache else { return }
        let durableSessions = sessions.map(Self.durableSessionCacheProjection)
        let previous = pendingCacheWriteTask
        pendingCacheWriteTask = Task.detached {
            await previous?.value
            await transcriptCache.storeSessions(durableSessions, agentID: agentID)
        }
    }

    /// Cache-first cold open: pre-paint the cached transcript/session list
    /// while the live requests are in flight (or failing while offline).
    /// Live history replaces the painted rows wholesale via the normal
    /// applyHistoryPayload reconciliation path.
    func paintFromCacheIfNeeded(session: SessionSnapshot) {
        guard let transcriptCache else { return }
        if sessions.isEmpty, !hasAppliedLiveSessions {
            let rosterRead = self.sidebarData?.beginRead()
            Task { [weak self] in
                let cached = await transcriptCache.loadSessions(agentID: session.deliveryAgentID)
                guard let self, !cached.isEmpty else { return }
                // A live sessions response (even an empty one) is authoritative;
                // a slow cache read must never repaint over it.
                // Session lists are always agent-scoped, even when the chat key
                // itself has immutable routing and ignores active-agent changes.
                guard self.isCurrentSession(session),
                      self.currentSessionSnapshot().deliveryAgentID == session.deliveryAgentID,
                      self.sessions.isEmpty,
                      !self.hasAppliedLiveSessions
                else {
                    return
                }
                let durableSessions = cached.map(Self.durableSessionCacheProjection)
                let organized = OpenClawChatSessionListOrganizer.organize(durableSessions)
                let agentScoped = organized.filter {
                    ChatSessionSidebarModel.isSessionInActiveAgentScope(
                        key: $0.key,
                        agentID: $0.agentId,
                        activeAgentID: session.deliveryAgentID)
                }
                let scoped = ChatSessionSidebarModel.clearingForeignGlobalObserverDigest(
                    in: agentScoped,
                    activeAgentId: session.deliveryAgentID)
                if let owner = self.sidebarData {
                    guard let rosterRead else { return }
                    owner.receive(scoped, read: rosterRead, replacingAgent: session.deliveryAgentID ?? "")
                } else {
                    self.sessions = self.applyingLocalUnreadOverrides(to: scoped)
                }
            }
        }
        guard messages.isEmpty, !hasAppliedLiveHistory else { return }
        Task { [weak self] in
            let cached = await transcriptCache.loadTranscript(
                sessionKey: session.key,
                agentID: Self.transcriptCacheAgentID(sessionKey: session.key, agentID: session.deliveryAgentID))
            guard let self, !cached.isEmpty else { return }
            guard self.isCurrentSession(session), !self.hasAppliedLiveHistory, self.messages.isEmpty else {
                return
            }
            self.replaceMessages(cached)
            self.isShowingCachedTranscript = true
        }
    }

    static func transcriptCacheAgentID(sessionKey: String, agentID: String?) -> String? {
        guard OpenClawChatSessionKey.agentID(from: sessionKey) == nil else { return nil }
        return ChatPayloadDecoding.trimmedNonEmptyString(agentID)?.lowercased()
    }
}
