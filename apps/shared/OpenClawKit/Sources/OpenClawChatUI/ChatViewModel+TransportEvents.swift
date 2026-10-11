import Foundation
import OpenClawKit
import OpenClawProtocol

@MainActor
private final class PendingRunOwnerReference {
    weak var value: OpenClawChatViewModel?

    init(_ value: OpenClawChatViewModel) {
        self.value = value
    }
}

extension OpenClawChatViewModel {
    /// Returns the task that settles the reconciliation this event starts, when it starts one.
    @discardableResult
    func handleTransportEvent(_ evt: OpenClawChatTransportEvent) -> Task<Void, Never>? {
        guard !self.isTransportDetached else { return nil }
        self.handleSidebarEvent(evt)
        if case .sessionObserver = evt, self.sidebarData != nil { return nil }
        if self.usesWebConversation {
            self.handleWebConversationEvent(evt)
            return nil
        }
        switch evt {
        case let .health(ok):
            let reconnected = ok && !self.healthOK
            applyTransportHealth(ok)
            if reconnected {
                self.refreshSourceContext()
                self.refreshAgentsIfRequested()
                let session = self.currentSessionSnapshot()
                Task { [weak self] in await self?.fetchModels(sessionSnapshot: session) }
                self.scheduleProgressCardFetch()
                Task { [weak self] in await self?.refreshQuestions() }
                Task { [weak self] in await self?.refreshSwarmCapability() }
                Task { [weak self] in await self?.loadComposerCapabilities(force: true) }
            } else if !ok {
                self.sourcePreviewState.invalidate()
                self.invalidateAgentCatalog()
                self.modelAvailabilityIsSessionScoped = false
                self.invalidateComposerCapabilities()
            }
        case .tick:
            let context = self.currentSessionSnapshot()
            Task { await self.pollHealthIfNeeded(force: false, sessionSnapshot: context) }
        case .chatMetadataChanged, .modelSelectionChanged:
            if case .modelSelectionChanged = evt {
                self.invalidateModelChoices()
            }
            self.refreshSourceContext()
            self.refreshAgentsIfRequested()
            let session = self.currentSessionSnapshot()
            let models = Task { [weak self] in await self?.fetchModels(sessionSnapshot: session) }
            let swarm = Task { [weak self] in await self?.refreshSwarmCapability(sessionSnapshot: session) }
            return Task { _ = await (models.value, swarm.value) }
        case let .sessionsChanged(change):
            return self.handleSessionsChangedEvent(change)
        case let .sessionObserver(digest):
            self.sessions = ChatSessionSidebarModel.applying(
                observerDigest: digest,
                to: self.sessions,
                activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
        case let .chat(chat):
            return self.handleChatEvent(chat)
        case let .sessionMessage(message):
            self.handleSessionMessageEvent(message)
        case let .agent(agent):
            return self.handleAgentEvent(agent)
        case let .sessionReaction(event):
            self.handleSessionReactionEvent(event)
        case let .progressCardChanged(event):
            return self.handleProgressCardChanged(event)
        case .questionRequested, .questionResolved:
            return self.handleQuestionEvent(evt)
        case .routeChanged, .reconnected, .seqGap:
            self.resetSessionReactions()
            self.invalidateSessionMetadataReadiness()
            self.syncSessionReactions(refreshMetadata: true)
            self.cancelHistoryInvalidationRefresh()
            self.invalidateModelChoices()
            self.refreshSourceContext()
            self.invalidateAgentCatalog(clear: true)
            self.refreshAgentsIfRequested()
            switch evt {
            case .routeChanged, .reconnected:
                self.questionAttentionOwnerID = UUID()
                self.applyProgressCard(nil)
            default: break
            }
            // Apple transports publish replacement sockets through either event.
            // Old known-absent state must not authorize legacy plans on the new Gateway.
            self.progressCardStoreAvailable = nil
            self.invalidateProgressCardTarget()
            self.modelAvailabilityIsSessionScoped = false
            let session = self.currentSessionSnapshot()
            Task { [weak self] in await self?.fetchModels(sessionSnapshot: session) }
            self.invalidateComposerCapabilities()
            Task { [weak self] in await self?.loadComposerCapabilities(force: true) }
            self.errorText = nil
            self.swarmEnabled = false
            self.resetSwarmProgress()
            Task { [weak self] in await self?.refreshSwarmCapability() }
            self.invalidateHistorySnapshots()
            self.invalidateRunSnapshots()
            self.clearPendingRuns()
            self.invalidateIncompleteLiveRunUsage()
            self.clearStreamingActivity()
            let context = self.beginHistoryRequest()
            // Question refresh is best-effort and must not delay transcript
            // recovery behind a slow gateway round trip.
            Task { await self.refreshQuestions() }
            return Task {
                await self.refreshHistoryAfterRun(historyRequest: context)
                await self.pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
            }
        }
        return nil
    }

    func applySessionChangeProjection(
        _ change: OpenClawChatSessionsChangedEvent,
        ownedSwarmActivityNote: Bool)
    {
        let projectedSessions = ChatSessionSidebarModel.applying(
            sessionChange: change,
            to: self.sessions,
            activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
        if let projectedSessions {
            self.sessions = projectedSessions
        } else if !ownedSwarmActivityNote, change.reason != "patch", change.reason != "command-metadata" {
            let context = self.currentSessionSnapshot()
            Task { await self.fetchSessions(limit: 50, sessionSnapshot: context) }
        }
    }

    private func handleSessionsChangedEvent(_ change: OpenClawChatSessionsChangedEvent) -> Task<Void, Never>? {
        // Broad subscribers see every agent's canonical global row. Gate
        // ownership before the shared-key projection can replace local state.
        let eventSessionKey = change.sessionKey ?? change.session?.key
        guard ChatSessionSidebarModel.sessionMatchesActiveAgent(
            sessionKey: eventSessionKey,
            agentId: change.agentId,
            activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
        else { return nil }
        let matchesCurrentSession = { (key: String?) in
            key.map { self.matchesCurrentSessionKey(incoming: $0, agentId: change.agentId, current: self.sessionKey) }
                ?? false
        }
        let swarmEvent = self.observeSwarmEvent(change)
        let ownedSwarmActivityNote = swarmEvent && SelfContainedSwarmHelpers.isActivityNote(change)

        let phase = change.phase?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let phase,
           phase == "start" || phase == "end" || phase == "error"
        {
            self.handleLifecycleSessionChange(change, phase: phase)
            return nil
        }

        self.applySessionChangeProjection(change, ownedSwarmActivityNote: ownedSwarmActivityNote)
        // Group-catalog mutations from any client arrive as reason "groups"
        // (mirrors web ui/src/lib/sessions); bump the revision so views keyed
        // on it refetch. Rename/delete also rewrite member sessions' category.
        if change.reason == "groups" {
            self.sessionGroupsRevision += 1
            self.refreshSessions(limit: 50)
            return nil
        }
        if change.reason == "rewind" || change.reason == "branch-switch" {
            guard matchesCurrentSession(change.sessionKey) else { return nil }
            self.replyTarget = nil
            self.narration = ChatNarration()
            self.runMessageScopesByRunID.removeAll()
            self.provisionalFinalMessagesByID.removeAll()
            let context = self.beginHistoryRequest()
            if change.reason == "branch-switch" {
                let switchActivity = self.beginSessionBranchSwitchActivity(for: context.session)
                return Task {
                    defer { self.endSessionBranchSwitchActivity(switchActivity) }
                    await self.reconcileSessionBranchChange(
                        switchActivity,
                        confirmFromBranchRefresh: true)
                }
            }
            return Task {
                await self.refreshHistoryAfterRun(historyRequest: context)
                guard self.isCurrentSession(context.session) else { return }
                await self.refreshSessionBranches(confirmingBranchChange: true)
            }
        }
        if phase == "message", matchesCurrentSession(eventSessionKey) {
            self.cancelHistoryInvalidationRefresh()
            self.invalidateHistorySnapshots()
            let context = self.beginHistoryRequest()
            let owner = PendingRunOwnerReference(self)
            self.historyInvalidationRefresh = (context.id, Task {
                await Self.refreshInvalidatedHistory(owner: owner, request: context)
            })
        }
        guard change.reason == "patch" || change.reason == "command-metadata" else { return nil }
        self.refreshSessions(limit: 50)
        guard matchesCurrentSession(eventSessionKey) else { return nil }
        let session = self.currentSessionSnapshot()
        return Task { [weak self] in await self?.fetchModels(sessionSnapshot: session) }
    }

    private func handleLifecycleSessionChange(
        _ change: OpenClawChatSessionsChangedEvent,
        phase: String)
    {
        let eventSessionKey = change.sessionKey ?? change.session?.key
        let changesCurrentSession = eventSessionKey.map {
            self.matchesCurrentSessionKey(
                incoming: $0,
                agentId: change.agentId,
                current: self.sessionKey)
        } ?? false
        let isTerminal = phase == "end" || phase == "error"
        let runID = isTerminal
            ? self.terminalRunID(
                explicitRunID: change.runId,
                sessionKey: eventSessionKey,
                agentID: change.agentId,
                includeAdvertisedRuns: true)
            : ChatPayloadDecoding.trimmedNonEmptyString(change.runId)
        let ownsCurrentRun = changesCurrentSession && runID.map {
            self.pendingRuns.contains($0) || self.ownsLiveTelemetryRun($0)
        } == true

        if isTerminal, ownsCurrentRun, let runID {
            let wasSelectedRun = self.liveUsageRunID == runID
            self.retirePendingRun(
                runID,
                hapticEvent: phase == "error" ? .runFailed : .runCompleted)
            if wasSelectedRun {
                self.clearStreamingActivity()
            }
            if self.liveUsageRunID == nil {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
            }
        }

        let mergedSnapshot: Bool
        if change.session != nil {
            mergedSnapshot = self.mergeLifecycleSessionSnapshot(change, phase: phase, runID: runID)
        } else {
            if let projected = ChatSessionSidebarModel.applying(
                sessionChange: change,
                to: self.sessions,
                activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
            {
                self.sessions = projected
            }
            mergedSnapshot = false
        }

        if !mergedSnapshot {
            self.refreshSessions(limit: 50)
        }
    }

    private func mergeLifecycleSessionSnapshot(
        _ change: OpenClawChatSessionsChangedEvent,
        phase: String,
        runID: String?) -> Bool
    {
        guard let snapshot = change.session else { return false }
        guard self.lifecycleSnapshotMatchesEvent(snapshot, change: change) else { return false }
        guard let index = self.lifecycleSessionIndex(snapshot, change: change) else { return false }

        let existing = self.sessions[index]
        guard Self.canMergeLifecycleSnapshot(
            snapshot: snapshot,
            existing: existing,
            phase: phase,
            runID: runID)
        else { return false }

        var updated = self.sessions
        updated[index] = Self.mergedLifecycleSession(
            existing: existing,
            snapshot: snapshot,
            phase: phase,
            activeRunIDs: change.activeRunIds,
            activeRunIDsPresent: change.activeRunIdsPresent,
            color: change.color,
            colorPresent: change.colorPresent)
        self.sessions = OpenClawChatSessionListOrganizer.organize(updated)
        self.persistSessionsToCache(
            self.sessions,
            agentID: self.currentSessionSnapshot().deliveryAgentID)
        return true
    }

    private func lifecycleSnapshotMatchesEvent(
        _ snapshot: OpenClawChatSessionEntry,
        change: OpenClawChatSessionsChangedEvent) -> Bool
    {
        guard let eventKey = change.sessionKey, snapshot.key != eventKey else { return true }
        return self.matchesCurrentSessionKey(
            incoming: snapshot.key,
            agentId: change.agentId,
            current: eventKey)
    }

    private func lifecycleSessionIndex(
        _ snapshot: OpenClawChatSessionEntry,
        change: OpenClawChatSessionsChangedEvent) -> Int?
    {
        if let exactIndex = self.sessions.firstIndex(where: { $0.key == snapshot.key }) {
            return exactIndex
        }
        if let eventKey = change.sessionKey,
           let eventKeyIndex = self.sessions.firstIndex(where: { $0.key == eventKey })
        {
            return eventKeyIndex
        }
        return self.sessions.firstIndex(where: { session in
            self.matchesCurrentSessionKey(
                incoming: snapshot.key,
                agentId: change.agentId,
                current: session.key)
        })
    }

    private static func canMergeLifecycleSnapshot(
        snapshot: OpenClawChatSessionEntry,
        existing: OpenClawChatSessionEntry,
        phase: String,
        runID: String?) -> Bool
    {
        if phase == "start" {
            guard let snapshotUpdatedAt = snapshot.updatedAt else { return false }
            if let existingUpdatedAt = existing.updatedAt, snapshotUpdatedAt <= existingUpdatedAt {
                return false
            }
        } else if let snapshotUpdatedAt = snapshot.updatedAt,
                  let existingUpdatedAt = existing.updatedAt,
                  snapshotUpdatedAt < existingUpdatedAt
        {
            return false
        }

        guard phase == "end" || phase == "error", let runID else { return true }
        let activeRunIDs = existing.activeRunIds?.compactMap { ChatPayloadDecoding.trimmedNonEmptyString($0) } ?? []
        if !activeRunIDs.isEmpty {
            return activeRunIDs == [runID]
        }
        return existing.hasActiveRun != true
    }

    private static func mergedLifecycleSession(
        existing: OpenClawChatSessionEntry,
        snapshot: OpenClawChatSessionEntry,
        phase: String,
        activeRunIDs: [String]?,
        activeRunIDsPresent: Bool,
        color: String?,
        colorPresent: Bool) -> OpenClawChatSessionEntry
    {
        var merged = existing
        if colorPresent {
            merged.color = color
        }
        merged.updatedAt = snapshot.updatedAt ?? existing.updatedAt
        merged.status = snapshot.status ?? existing.status
        merged.hasActiveRun = snapshot.hasActiveRun ?? existing.hasActiveRun
        if phase == "start" || phase == "end" {
            merged.lastRunError = snapshot.lastRunError
        } else {
            merged.lastRunError = snapshot.lastRunError ?? existing.lastRunError
        }

        if activeRunIDsPresent {
            merged.activeRunIds = activeRunIDs
        }

        merged.startedAt = snapshot.startedAt ?? existing.startedAt
        if phase == "start" {
            merged.endedAt = nil
            merged.runtimeMs = nil
            merged.outputTokens = nil
        } else {
            merged.endedAt = snapshot.endedAt ?? existing.endedAt
            merged.runtimeMs = snapshot.runtimeMs ?? existing.runtimeMs
            merged.outputTokens = snapshot.outputTokens ?? existing.outputTokens
        }
        return merged
    }

    private func terminalRunID(
        explicitRunID: String?,
        sessionKey: String?,
        agentID: String?,
        includeAdvertisedRuns: Bool) -> String?
    {
        if let explicitRunID = ChatPayloadDecoding.trimmedNonEmptyString(explicitRunID) {
            return explicitRunID
        }
        if sessionKey == nil {
            return self.pendingRuns.count == 1 ? self.pendingRuns.first : nil
        }
        guard let sessionKey,
              self.matchesCurrentSessionKey(
                  incoming: sessionKey,
                  agentId: agentID,
                  current: self.sessionKey)
        else {
            return nil
        }
        let ownedRunIDs = includeAdvertisedRuns
            ? self.pendingRuns.union(Set(self.liveAdvertisedRunIDs))
            : self.pendingRuns
        return ownedRunIDs.count == 1 ? ownedRunIDs.first : nil
    }

    private func handleSessionMessageEvent(_ payload: OpenClawSessionMessageEventPayload) {
        let isCurrentSession = payload.sessionKey.map {
            self.matchesCurrentSessionKey(incoming: $0, agentId: payload.agentId, current: self.sessionKey)
        } ?? true
        if isCurrentSession, payload.hasActiveRun != nil || payload.activeRunIdsPresent {
            let change = OpenClawChatSessionsChangedEvent(
                sessionKey: payload.sessionKey,
                agentId: payload.agentId,
                reason: "message",
                hasActiveRun: payload.hasActiveRun,
                activeRunIds: payload.activeRunIds,
                activeRunIdsPresent: payload.activeRunIdsPresent)
            if let projected = ChatSessionSidebarModel.applying(
                sessionChange: change,
                to: self.sessions,
                activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
            {
                self.sessions = projected
            }
            if payload.activeRunIdsPresent {
                self.updateActiveSessionRunIDs(payload.activeRunIds ?? [])
            }
        }
        guard let message = payload.message else { return }
        let sanitized = Self.stripInboundMetadata(from: message)
        // Confirmation is gateway-scoped, not presentation-scoped. A flush
        // can drain session A while session B is visible, and A's event must
        // still retire its durable row before this handler returns early.
        confirmOutboxCommands(in: [sanitized])
        guard isCurrentSession else { return }
        self.observeOutboxTranscriptTip(sanitized, session: self.currentSessionSnapshot())

        self.invalidateHistorySnapshots()
        // The active client also receives the gateway's echo of the user turn it
        // just sent. performSend already appended an optimistic row carrying a
        // local client timestamp, while the echo carries a server timestamp, so
        // the timestamp-keyed identity/dedupe paths below never collapse them.
        // Adopt the server record onto the exactly correlated row even when the
        // run's final event already cleared pending state. Same-content turns
        // without this key remain distinct.
        if adoptCorrelatedUserMessage(incoming: sanitized) {
            self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
            self.applyDeferredExternalStateIfReady()
            return
        }
        if adoptProvisionalFinalMessage(incoming: sanitized) {
            self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [sanitized])
        replaceMessages(Self.dedupeMessages(reconciled))
        pruneProvisionalFinalMessages()
        pruneRunMessageScopes()
        self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
        self.applyDeferredExternalStateIfReady()
    }

    private func handleChatEvent(_ chat: OpenClawChatEventPayload) -> Task<Void, Never>? {
        let explicitRunID = ChatPayloadDecoding.trimmedNonEmptyString(chat.runId)
        let isOurRun = explicitRunID.map { self.pendingRuns.contains($0) } ?? false
        if let runID = explicitRunID {
            self.logDiagnostic(
                "chat.ui event chat state=\(chat.state ?? "unknown") "
                    + "runId=\(runID) ours=\(isOurRun) pending=\(self.pendingRunCount)")
        }

        // Gateway may publish canonical session keys (for example "agent:main:main")
        // even when this view currently uses an alias key (for example "main").
        // Never drop events for our own pending run on key mismatch, or the UI can stay
        // stuck at "thinking" until the user reopens and forces a history reload.
        let matchesCurrentSession = chat.sessionKey.map {
            self.matchesCurrentSessionKey(
                incoming: $0,
                agentId: chat.agentId,
                current: self.sessionKey)
        } ?? true
        guard matchesCurrentSession || isOurRun else { return nil }
        if chat.state == "delta", let runID = explicitRunID {
            guard self.pendingRuns.isEmpty || self.pendingRuns.contains(runID) else { return nil }
            self.invalidateRunSnapshots()
            self.adoptRun(
                runId: runID,
                bufferedText: OpenClawChatEventText.assistantText(from: chat) ?? "")
            return nil
        }

        let isTerminal = chat.state == "final" || chat.state == "aborted" || chat.state == "error"
        let terminalRunID = isTerminal
            ? self.terminalRunID(
                explicitRunID: explicitRunID,
                sessionKey: chat.sessionKey,
                agentID: chat.agentId,
                includeAdvertisedRuns: false)
            : nil
        let ownsTerminalRun = terminalRunID.map { self.pendingRuns.contains($0) } == true
        let settlesAdvertisedRun = matchesCurrentSession && explicitRunID.map {
            self.activeSessionRunIDs.contains($0)
        } == true
        let settlesBooleanOnlyRun =
            matchesCurrentSession && explicitRunID == nil && self.pendingRuns.isEmpty &&
            self.activeSessionRunIDs.isEmpty && self.hasActiveSessionRunWithoutChatSnapshot
        if isTerminal {
            self.invalidateHistorySnapshots()
            if settlesAdvertisedRun, !ownsTerminalRun {
                self.retireTerminalRun(explicitRunID)
            }
            if ownsTerminalRun || settlesBooleanOnlyRun {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
            }
        }
        self.invalidateRunSnapshots()

        guard isOurRun || ownsTerminalRun else {
            // Another client's completion refreshes durable history, but cannot
            // erase singleton activity owned by this client's selected run.
            if isTerminal {
                if self.liveLocalRunIDs.isEmpty {
                    self.updateStreamingAssistantText(nil)
                    self.turnToolCallsById = [:]
                }
                self.appendFinalChatMessageIfPresent(chat)
                let context = self.beginHistoryRequest()
                return Task { _ = await self.refreshHistoryAfterRun(historyRequest: context) }
            }
            return nil
        }

        guard isTerminal, let terminalRunID else { return nil }
        if chat.state == "error" {
            self.errorText = chat.errorMessage ?? "Chat failed"
        }
        let hapticEvent: OpenClawChatHaptics.Event? = switch chat.state {
        case "final": .runCompleted
        case "error": .runFailed
        default: nil
        }
        self.retirePendingRun(terminalRunID, hapticEvent: hapticEvent)
        self.clearStreamingActivity()
        self.appendFinalChatMessageIfPresent(chat)
        let context = self.beginHistoryRequest()
        self.applyDeferredExternalStateIfReady()
        return Task { _ = await self.refreshHistoryAfterRun(historyRequest: context) }
    }

    private func appendFinalChatMessageIfPresent(_ chat: OpenClawChatEventPayload) {
        guard chat.state == "final", let text = OpenClawChatEventText.assistantText(from: chat) else { return }

        let decoded = chat.message.flatMap {
            try? GatewayPayloadDecoding.decode($0, as: OpenClawChatMessage.self)
        }
        let message = if let decoded,
                         Self.isAssistantMessage(decoded)
        {
            Self.messageWithTimestampIfNeeded(decoded)
        } else {
            OpenClawChatMessage(
                role: "assistant",
                content: [
                    OpenClawChatMessageContent(
                        type: "text",
                        text: text),
                ],
                timestamp: Date().timeIntervalSince1970 * 1000,
                stopReason: "stop")
        }

        let runId = ChatPayloadDecoding.trimmedNonEmptyString(chat.runId)
        let scope = runMessageScope(for: runId)
        guard self.isCurrentSession(scope.session) else { return }
        guard let reconciliationKey = Self.finalMessageReconciliationKey(for: message) else { return }
        if let runId, hasRecordedFinalMessage(runId: runId) {
            return
        }

        if hasCanonicalFinalMessageMatching(message, scope: scope) {
            if let runId {
                self.runMessageScopesByRunID.removeValue(forKey: runId)
            }
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [message])
        replaceMessages(Self.dedupeMessages(reconciled))
        if self.messages.contains(where: { $0.id == message.id }) {
            self.provisionalFinalMessagesByID[message.id] = ProvisionalFinalMessage(
                reconciliationKey: reconciliationKey,
                runId: runId,
                scope: scope)
        }
        pruneProvisionalFinalMessages()
        pruneRunMessageScopes()
    }

    static func isAssistantMessage(_ message: OpenClawChatMessage) -> Bool {
        message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
    }

    private static func messageWithTimestampIfNeeded(_ message: OpenClawChatMessage) -> OpenClawChatMessage {
        guard message.timestamp == nil else { return message }
        var timestamped = message
        timestamped.timestamp = Date().timeIntervalSince1970 * 1000
        return timestamped
    }

    private func handleAgentEvent(_ evt: OpenClawAgentEventPayload) -> Task<Void, Never>? {
        if evt.stream == "usage" {
            self.handleAgentUsageEvent(evt)
            return nil
        }

        let isPendingRun = self.pendingRuns.contains(evt.runId)
        let isAdvertisedRun = self.activeSessionRunIDs.contains(evt.runId)
        let isLegacySessionStream = self.pendingRuns.isEmpty && self.sessionId == evt.runId
        if evt.stream == "lifecycle" {
            guard isPendingRun || isAdvertisedRun || isLegacySessionStream else { return nil }
            return self.handleAgentLifecycleEvent(
                evt,
                isPendingRun: isPendingRun,
                isAdvertisedRun: isAdvertisedRun,
                isSelectedRun: self.liveUsageRunID == evt.runId,
                isLegacySessionStream: isLegacySessionStream)
        }

        let isSelectedPendingRun = isPendingRun && self.liveUsageRunID == evt.runId
        if evt.stream == "item", evt.data["kind"]?.value as? String == "preamble" {
            self.handleAgentNarration(evt)
            return nil
        }
        guard isSelectedPendingRun || isLegacySessionStream else { return nil }
        self.invalidateRunSnapshots()
        self.logDiagnostic(
            "chat.ui event agent stream=\(evt.stream) "
                + "runId=\(evt.runId) pending=\(self.pendingRunCount)")

        switch evt.stream {
        case "assistant":
            if let text = evt.data["text"]?.value as? String {
                self.liveRunStateByRunID[evt.runId, default: ChatLiveRunState()].hasAgentAssistantText = true
                self.updateActiveSessionRunWithoutChatSnapshot(false)
                self.updateStreamingAssistantText(text)
            }
        case "plan":
            // Released Gateways through v2026.8.x lack progressCard.get and only emit stream:"plan".
            // Rendering these only when the store is known-absent keeps a dual-emitting Gateway from
            // fighting the durable card. SUNSET 2026-10-18: this fallback is a fixed cutover window,
            // not a permanent contract. On that date delete it together with the Gateway's legacy
            // stream:"plan" dual-emit and the Android twin in ChatController.kt. Tracked: #125639.
            guard self.progressCardStoreAvailable == false else { return nil }
            guard evt.data["phase"]?.value as? String == "update" else { return nil }
            let steps = Self.parseLegacyProgressCardSteps(evt.data["steps"])
            guard !steps.isEmpty else {
                self.clearProgressCard()
                return nil
            }
            self.legacyProgressCardRevision &+= 1
            let explanation = (evt.data["explanation"]?.value as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.applyProgressCard(ProgressCard(
                sessionkey: self.sessionKey,
                revision: self.legacyProgressCardRevision,
                updatedat: evt.ts ?? 0,
                markdown: explanation?.isEmpty == false ? explanation : nil,
                steps: steps))
        case "item":
            self.handleAgentActivityItem(evt)
        case "tool":
            self.handleAgentToolEvent(evt)
        default:
            break
        }
        return nil
    }

    private func handleAgentToolEvent(_ evt: OpenClawAgentEventPayload) {
        guard let phase = evt.data["phase"]?.value as? String else { return }
        guard let name = evt.data["name"]?.value as? String else { return }
        guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
        if phase == "start" {
            self.updateActiveSessionRunWithoutChatSnapshot(false)
            let args = evt.data["args"]
            self.turnToolCallsById[toolCallId] = OpenClawChatPendingToolCall(
                toolCallId: toolCallId,
                name: name,
                args: args,
                startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                isError: nil,
                diffStat: nil,
                activity: self.turnToolCallsById[toolCallId]?.activity,
                runID: evt.runId)
        } else if phase == "input_delta",
                  var pending = self.turnToolCallsById[toolCallId],
                  let diff = evt.data["diff"]?.dictionaryValue,
                  let added = diff["added"]?.intValue,
                  let removed = diff["removed"]?.intValue,
                  added >= 0,
                  removed >= 0
        {
            pending.diffStat = ChatToolDiffStat(added: added, removed: removed)
            self.turnToolCallsById[toolCallId] = pending
        } else if phase == "result" {
            if var pending = self.turnToolCallsById[toolCallId], pending.activity != nil {
                pending.isComplete = true
                self.turnToolCallsById[toolCallId] = pending
            } else {
                self.turnToolCallsById[toolCallId] = nil
            }
        }
    }

    private func handleAgentUsageEvent(_ evt: OpenClawAgentEventPayload) {
        guard let sequence = evt.seq,
              let outputTokens = evt.data["outputTokens"]?.value as? Int
        else {
            return
        }
        self.acceptLiveRunSequence(
            runID: evt.runId,
            sequence: sequence,
            outputTokens: outputTokens)
    }

    private func handleAgentLifecycleEvent(
        _ evt: OpenClawAgentEventPayload,
        isPendingRun: Bool,
        isAdvertisedRun: Bool,
        isSelectedRun: Bool,
        isLegacySessionStream: Bool) -> Task<Void, Never>?
    {
        let phase = Self.lowercasedAgentEventString(evt.data["phase"])
        let status = Self.lowercasedAgentEventString(evt.data["status"])
        let aborted = Self.agentEventBool(evt.data["aborted"])
        let isFailure =
            phase == "error" || phase == "failed" || phase == "aborted" ||
            status == "error" || status == "failed" || status == "aborted"
        let isSuccessfulStatus =
            status == "ok" || status == "success" || status == "succeeded" ||
            status == "complete" || status == "completed"
        let isTerminalPhase = phase == "end" || phase == "complete" || phase == "completed"

        if phase == "start" {
            guard let sequence = evt.seq else { return nil }
            _ = self.acceptLiveRunSequence(runID: evt.runId, sequence: sequence)
            return nil
        }
        guard isTerminalPhase || isFailure || aborted || isSuccessfulStatus else { return nil }
        let acceptedLifecycle = if isLegacySessionStream {
            true
        } else if let sequence = evt.seq {
            self.acceptLiveRunSequence(runID: evt.runId, sequence: sequence)
        } else {
            isPendingRun || isAdvertisedRun || isSelectedRun
        }
        guard acceptedLifecycle else { return nil }

        self.invalidateHistorySnapshots()
        if isPendingRun {
            self.retirePendingRun(
                evt.runId,
                hapticEvent: isFailure || aborted ? .runFailed : .runCompleted)
        } else if !isLegacySessionStream || evt.seq == nil {
            // Sequenced legacy streams carry a session ID.
            self.retireTerminalRun(evt.runId)
        }
        guard isSelectedRun || isLegacySessionStream else {
            self.refreshSessions(limit: 50)
            return nil
        }

        self.updateActiveSessionRunWithoutChatSnapshot(false)
        if isFailure || aborted {
            self.errorText = Self.agentLifecycleErrorMessage(evt, aborted: aborted)
        }
        self.clearStreamingActivity()
        let context = self.beginHistoryRequest()
        self.applyDeferredExternalStateIfReady()
        return Task { _ = await self.refreshHistoryAfterRun(historyRequest: context) }
    }

    private static func lowercasedAgentEventString(_ value: AnyCodable?) -> String? {
        (value?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func agentEventBool(_ value: AnyCodable?) -> Bool {
        if let boolValue = value?.value as? Bool {
            return boolValue
        }
        guard let stringValue = lowercasedAgentEventString(value) else {
            return false
        }
        return stringValue == "true" || stringValue == "yes" || stringValue == "1"
    }

    private static func agentLifecycleErrorMessage(_ evt: OpenClawAgentEventPayload, aborted: Bool) -> String {
        if aborted {
            return "Run aborted"
        }
        for key in ["error", "message"] {
            if let message = evt.data[key]?.value as? String,
               !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                return message
            }
        }
        return "Chat failed"
    }

    func finishPendingRunAfterTerminalOkSendAck(_ response: OpenClawChatSendResponse) {
        self.retirePendingRun(response.runId, hapticEvent: .runCompleted)
        self.clearStreamingActivity()
        self.logDiagnostic(
            "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                + "runId=\(response.runId) status=ok")
    }

    func finishPendingRunIfTerminalSendAck(_ response: OpenClawChatSendResponse) -> Bool {
        guard response.status == "timeout" || response.status == "error" else { return false }
        self.removePendingLocalUserEcho(for: response.runId)
        self.clearStreamingActivity()
        self.errorText = "Chat failed before the run started; try again."
        self.retirePendingRun(response.runId, hapticEvent: .runFailed)
        self.logDiagnostic(
            "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                + "runId=\(response.runId) status=\(response.status)")
        return true
    }

    func removePendingLocalUserEcho(for runId: String) {
        guard let messageID = pendingLocalUserEchoMessageIDsByRunID[runId] else { return }
        self.removeMessage(id: messageID)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
    }

    private func refreshIfPending(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64,
        after timestamp: Double?,
        terminalState: OpenClawChatRunTerminalState? = nil,
        allowNoOutputCompletion: Bool = false,
        diagnostic: String) async -> Bool
    {
        guard self.isCurrentPendingRunOwner(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        else {
            return false
        }
        self.logDiagnostic(diagnostic)
        let historyContext = self.beginHistoryRequest(for: sessionSnapshot)
        let refresh = await refreshHistoryAfterRun(historyRequest: historyContext)
        guard self.isCurrentPendingRunOwner(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        else { return false }
        // Live events advance ownership while history is in flight. A superseded snapshot
        // must not let message shape retire a run the gateway still reports in flight.
        if refresh.applied, !refresh.runSnapshotApplied { return true }
        if case let .failed(message)? = terminalState {
            if refresh.applied,
               !refresh.hasInFlightRun,
               let timestamp,
               self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
            {
                return false
            }
            self.errorText = message
            self.retirePendingRun(runId, hapticEvent: .runFailed)
            self.clearStreamingActivity()
            return false
        }
        if refresh.applied, refresh.supportsInFlightRunState {
            if refresh.hasInFlightRun {
                return true
            }
            if refresh.sessionHasActiveRun,
               Self.hasUnansweredLatestUser(in: self.messages)
            {
                // A session-level active bit cannot identify a new chat run,
                // but it is enough to retain the run ID this client already owns.
                self.clearStreamingActivity()
                return true
            }
        }
        guard !refresh.hasInFlightRun else { return true }
        if let timestamp,
           self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
        {
            return false
        }
        if refresh.applied, terminalState == .completed, allowNoOutputCompletion {
            self.retirePendingRun(runId, hapticEvent: .runCompleted)
            self.clearStreamingActivity()
            return false
        }
        return true
    }

    private func isCurrentPendingRunOwner(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64) -> Bool
    {
        self.isCurrentSession(sessionSnapshot) &&
            self.pendingRuns.contains(runId) &&
            self.pendingRunOwnerArmIDs[runId] == armID
    }

    @discardableResult
    func clearPendingRunIfAssistantMessagePresent(runId: String, after timestamp: Double) -> Bool {
        guard let hapticEvent = assistantHapticEvent(after: timestamp) else { return false }
        self.retirePendingRun(runId, hapticEvent: hapticEvent)
        self.clearStreamingActivity()
        return true
    }

    static func hasUnansweredLatestUser(in messages: [OpenClawChatMessage]) -> Bool {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else { return false }
        return !self.hasAssistantMessage(after: lastUserIndex, in: messages)
    }

    static func latestUserTurn(in messages: [OpenClawChatMessage]) -> LatestUserTurn? {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else {
            return nil
        }
        return self.userTurn(at: lastUserIndex, in: messages)
    }

    static func userTurn(
        at userIndex: [OpenClawChatMessage].Index,
        in messages: [OpenClawChatMessage]) -> LatestUserTurn?
    {
        guard messages.indices.contains(userIndex),
              messages[userIndex].role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        else {
            return nil
        }
        let refreshKey = self.userRefreshIdentityKey(for: messages[userIndex])
        let occurrence = refreshKey.map { key in
            messages[...userIndex].count { self.userRefreshIdentityKey(for: $0) == key }
        } ?? 0
        return LatestUserTurn(
            idempotencyKey: ChatPayloadDecoding.trimmedNonEmptyString(messages[userIndex].idempotencyKey),
            refreshKey: refreshKey,
            occurrence: occurrence,
            timestamp: messages[userIndex].timestamp)
    }

    static func hasAnsweredUser(
        _ user: LatestUserTurn,
        in messages: [OpenClawChatMessage])
        -> Bool
    {
        // Hooks may transform persisted user content while preserving this key.
        // Prefer the durable turn identity so a completed refresh rejects older history.
        if let idempotencyKey = user.idempotencyKey {
            guard let userIndex = messages.lastIndex(where: { message in
                message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                    ChatPayloadDecoding.trimmedNonEmptyString(message.idempotencyKey) == idempotencyKey
            }) else {
                return false
            }
            return self.hasAssistantMessage(after: userIndex, in: messages)
        }
        guard let refreshKey = user.refreshKey else { return false }
        var occurrence = 0
        var latestMatchingUserIndex: [OpenClawChatMessage].Index?
        for (index, message) in messages.enumerated() {
            guard userRefreshIdentityKey(for: message) == refreshKey else { continue }
            occurrence += 1
            latestMatchingUserIndex = index
            guard occurrence == user.occurrence else { continue }
            return self.hasAssistantMessage(after: index, in: messages)
        }
        guard let latestMatchingUserIndex,
              messages.lastIndex(where: { $0.role.lowercased() == "user" }) == latestMatchingUserIndex
        else {
            return false
        }
        if let requestTimestamp = user.timestamp,
           let latestTimestamp = messages[latestMatchingUserIndex].timestamp,
           latestTimestamp < requestTimestamp
        {
            return false
        }
        return self.hasAssistantMessage(after: latestMatchingUserIndex, in: messages)
    }

    private static func hasAssistantMessage(
        after userIndex: [OpenClawChatMessage].Index,
        in messages: [OpenClawChatMessage]) -> Bool
    {
        let nextIndex = messages.index(after: userIndex)
        return messages[nextIndex...].contains { message in
            guard message.role.lowercased() == "assistant", message.streamSegmentID == nil else { return false }
            let text = message.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty || message.errorMessage != nil
        }
    }

    private static func assistantHapticEvent(
        for message: OpenClawChatMessage) -> OpenClawChatHaptics.Event?
    {
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant",
              message.streamSegmentID == nil
        else {
            return nil
        }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || message.errorMessage != nil else { return nil }
        let stopReason = message.stopReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return stopReason == "error" || stopReason == "aborted" ? .runFailed : .runCompleted
    }

    func assistantHapticEventAfterLatestUser() -> OpenClawChatHaptics.Event? {
        guard let userIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else { return nil }
        let nextIndex = self.messages.index(after: userIndex)
        return self.messages[nextIndex...].reversed().lazy.compactMap(Self.assistantHapticEvent).first
    }

    private func assistantHapticEvent(after timestamp: Double) -> OpenClawChatHaptics.Event? {
        self.messages.reversed().lazy.compactMap { message in
            guard (message.timestamp ?? 0) >= timestamp else { return nil }
            return Self.assistantHapticEvent(for: message)
        }.first
    }

    /// Pull canonical history for every session touched by one route-bound
    /// outbox pass. Background sessions only retire confirmed rows; the
    /// visible session also runs the normal reconciliation/cache pipeline.
    func refreshHistoriesAfterOutboxFlush(
        targets: Set<OutboxDeliveryTarget>,
        routeLease: OpenClawChatTransportRouteLease) async
    {
        let sortedTargets = targets.sorted { lhs, rhs in
            if lhs.deliverySessionKey != rhs.deliverySessionKey {
                return lhs.deliverySessionKey < rhs.deliverySessionKey
            }
            return (lhs.agentID ?? "") < (rhs.agentID ?? "")
        }
        for target in sortedTargets {
            let visibleRequest = !self.usesWebConversation && matchesCurrentSessionKey(
                incoming: target.presentationSessionKey,
                agentId: target.agentID,
                current: self.sessionKey)
                ? self.beginHistoryRequest()
                : nil
            do {
                let payload = try await routeLease.requestHistory(
                    sessionKey: target.deliverySessionKey,
                    agentID: target.agentID)
                let incoming = Self.decodeMessages(payload.messages ?? [], activity: payload.activity)
                await confirmOutboxCommandsNow(in: incoming)
                if let visibleRequest {
                    _ = self.applyHistoryPayload(
                        payload,
                        for: visibleRequest,
                        preservingOptimisticLocalMessages: true)
                }
            } catch is CancellationError {
                // The gateway route changed during confirmation. Keep every
                // unconfirmed row durable for a later matching reconnect.
                applyTransportHealth(false)
                return
            } catch {
                self.logDiagnostic(
                    "chat.ui outbox history failed sessionKey=\(target.deliverySessionKey) "
                        + "error=\(error.localizedDescription)")
            }
        }
    }

    @discardableResult
    func refreshHistoryAfterRun(
        historyRequest request: HistoryRequest? = nil,
        requireCurrentInvalidation: Bool = false) async
        -> RunHistoryRefreshResult
    {
        guard !self.usesWebConversation else { return .failed }
        let request = request ?? self.beginHistoryRequest()
        do {
            let payload = try await transport.requestHistory(sessionKey: request.session.key)
            guard !requireCurrentInvalidation || self.canRefreshInvalidatedHistory(request) else { return .failed }
            let runSnapshotApplied = request.runOwnershipGeneration == self.runOwnershipGeneration &&
                request.id >= self.latestAppliedRunSnapshotRequestID
            let applied = self.applyHistoryPayload(
                payload,
                for: request,
                preservingOptimisticLocalMessages: true)
            let hasInFlightRun = ChatPayloadDecoding.trimmedNonEmptyString(payload.inFlightRun?.runId) != nil
            let sessionHasActiveRun = payload.sessionInfo?.hasActiveRun == true
            // `hasActiveRun` is session-wide and can be true for an embedded agent run.
            // Its presence capability-gates an authoritative missing chat snapshot, but
            // only `inFlightRun` establishes ownership of the pending chat run.
            let supportsInFlightRunState = hasInFlightRun || payload.sessionInfo?.hasActiveRun != nil
            return RunHistoryRefreshResult(
                applied: applied,
                runSnapshotApplied: applied && runSnapshotApplied,
                supportsInFlightRunState: supportsInFlightRunState,
                hasInFlightRun: hasInFlightRun,
                sessionHasActiveRun: sessionHasActiveRun)
        } catch {
            chatUILogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
            var failure = RunHistoryRefreshResult.failed
            if let response = error as? GatewayResponseError,
               response.method == "chat.history", response.code == "UNAVAILABLE",
               response.details["retryable"]?.boolValue == true
            {
                failure.retryAfterMs = max(0, response.details["retryAfterMs"]?.intValue ?? 250)
            }
            return failure
        }
    }

    private func canRefreshInvalidatedHistory(_ request: HistoryRequest) -> Bool {
        !Task.isCancelled && self.canApplyHistory(request) &&
            self.historyInvalidationRefresh?.requestID == request.id
    }

    private static func refreshInvalidatedHistory(
        owner: PendingRunOwnerReference,
        request: HistoryRequest) async
    {
        defer {
            if let model = owner.value, model.historyInvalidationRefresh?.requestID == request.id {
                model.historyInvalidationRefresh = nil
            }
        }
        var delayMs = 250
        while let result = await Self.refreshCurrentInvalidatedHistory(owner: owner, request: request),
              let retryAfterMs = result.retryAfterMs
        {
            do {
                try await Task.sleep(for: .milliseconds(max(delayMs, retryAfterMs)))
            } catch {
                return
            }
            delayMs = min(delayMs * 2, 4000)
        }
    }

    private static func refreshCurrentInvalidatedHistory(
        owner: PendingRunOwnerReference,
        request: HistoryRequest) async -> RunHistoryRefreshResult?
    {
        // Release the model before backoff so abandoning a presentation can retire its retry.
        guard let model = owner.value, model.canRefreshInvalidatedHistory(request) else { return nil }
        let result = await model.refreshHistoryAfterRun(historyRequest: request, requireCurrentInvalidation: true)
        guard model.canRefreshInvalidatedHistory(request) else { return nil }
        return result
    }

    func armPendingRunOwner(
        runId: String,
        sessionSnapshot: SessionSnapshot? = nil,
        userMessageTimestamp: Double? = nil)
    {
        self.pendingRunOwnerTasks[runId]?.cancel()
        self.nextPendingRunOwnerArmID &+= 1
        let armID = self.nextPendingRunOwnerArmID
        let scope = self.runMessageScopesByRunID[runId]
        let session = sessionSnapshot ?? scope?.session ?? self.currentSessionSnapshot()
        let timestamp = userMessageTimestamp ?? scope?.latestUserTurn?.timestamp
        self.pendingRunOwnerArmIDs[runId] = armID
        // One arm owns both completion waits and history polling. Rearms cancel
        // every child so stale route/session results cannot retire a successor run.
        let owner = PendingRunOwnerReference(self)
        let transport = self.transport
        self.pendingRunOwnerTasks[runId] = Task {
            await Self.runPendingRunOwner(
                owner: owner,
                runId: runId,
                sessionSnapshot: session,
                userMessageTimestamp: timestamp,
                armID: armID,
                transport: transport)
        }
    }

    private nonisolated static func runPendingRunOwner(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        transport: any OpenClawChatTransport) async
    {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await Self.observePendingRunCompletion(
                    owner: owner,
                    runId: runId,
                    sessionSnapshot: sessionSnapshot,
                    userMessageTimestamp: userMessageTimestamp,
                    armID: armID,
                    transport: transport)
            }
            group.addTask {
                await Self.pollPendingRunHistory(
                    owner: owner,
                    runId: runId,
                    sessionSnapshot: sessionSnapshot,
                    userMessageTimestamp: userMessageTimestamp,
                    armID: armID)
            }
            _ = await group.next()
            group.cancelAll()
        }
    }

    private nonisolated static func observePendingRunCompletion(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        transport: any OpenClawChatTransport) async
    {
        var terminalState: OpenClawChatRunTerminalState?
        var completedObservedAtMs: Double?
        while let timeoutMs = await Self.pendingRunWaitTimeout(
            owner: owner,
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        {
            let observation = await transport.waitForRunCompletion(
                runId: runId,
                timeoutMs: timeoutMs)
            if case let .terminal(observedTerminalState) = observation {
                terminalState = observedTerminalState
                if observedTerminalState == .completed, completedObservedAtMs == nil {
                    completedObservedAtMs = Date().timeIntervalSince1970 * 1000
                }
            }
            let effectiveObservation = terminalState.map(OpenClawChatRunObservation.terminal) ?? observation
            guard let retryDelayMs = await Self.processPendingRunObservation(
                owner: owner,
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                userMessageTimestamp: userMessageTimestamp,
                armID: armID,
                observation: effectiveObservation,
                completedObservedAtMs: completedObservedAtMs)
            else { return }
            do {
                try await Task.sleep(nanoseconds: retryDelayMs * 1_000_000)
            } catch {
                return
            }
        }
    }

    private static func pendingRunWaitTimeout(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64) -> Int?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        return Int(model.pendingRunWaitTimeoutMs)
    }

    private static func processPendingRunObservation(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        observation: OpenClawChatRunObservation,
        completedObservedAtMs: Double?) async -> UInt64?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        let terminalState: OpenClawChatRunTerminalState?
        switch observation {
        case let .terminal(state):
            terminalState = state
        case .checkAgain:
            terminalState = nil
        case .unavailable:
            return model.pendingRunUnavailableRetryMs
        }
        let allowNoOutputCompletion = terminalState != nil && completedObservedAtMs.map {
            (Date().timeIntervalSince1970 * 1000) - $0 >= Double(model.pendingRunTerminalHistoryGraceMs)
        } == true
        let shouldContinue = await model.refreshIfPending(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID,
            after: userMessageTimestamp,
            terminalState: terminalState,
            allowNoOutputCompletion: allowNoOutputCompletion,
            diagnostic: "chat.ui run observation sessionKey=\(sessionSnapshot.key) "
                + "runId=\(runId) observation=\(observation)")
        return shouldContinue ? model.pendingRunTerminalRetryMs : nil
    }

    private nonisolated static func pollPendingRunHistory(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64) async
    {
        var delayIndex = 0
        while let delayMs = await Self.pendingRunRefreshDelay(
            owner: owner,
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID,
            delayIndex: delayIndex)
        {
            delayIndex += 1
            do {
                try await Task.sleep(nanoseconds: delayMs * 1_000_000)
            } catch {
                return
            }
            let shouldContinue = await Self.refreshPendingRunOwner(
                owner: owner,
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                armID: armID,
                after: userMessageTimestamp,
                diagnostic: "chat.ui pending refresh sessionKey=\(sessionSnapshot.key) "
                    + "runId=\(runId) delayMs=\(delayMs)")
            guard shouldContinue else { return }
        }
    }

    private static func pendingRunRefreshDelay(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64,
        delayIndex: Int) -> UInt64?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        return delayIndex < model.pendingRunRefreshDelaysMs.count
            ? model.pendingRunRefreshDelaysMs[delayIndex]
            : model.pendingRunSteadyRefreshDelayMs
    }

    private static func refreshPendingRunOwner(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64,
        after timestamp: Double?,
        diagnostic: String) async -> Bool
    {
        guard let model = owner.value else { return false }
        return await model.refreshIfPending(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID,
            after: timestamp,
            diagnostic: diagnostic)
    }

    func clearPendingRun(
        _ runId: String,
        hapticEvent: OpenClawChatHaptics.Event? = nil)
    {
        self.clearLiveRunState(for: runId)
        self.removePendingRun(runId, hapticEvent: hapticEvent)
    }

    func retirePendingRun(
        _ runId: String,
        hapticEvent: OpenClawChatHaptics.Event? = nil)
    {
        self.retireTerminalRun(runId)
        self.removePendingRun(runId, hapticEvent: hapticEvent)
    }

    private func removePendingRun(
        _ runId: String,
        hapticEvent: OpenClawChatHaptics.Event?)
    {
        let wasPending = self.pendingRuns.contains(runId)
        self.pendingRuns.remove(runId)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
        self.pendingRunOwnerTasks[runId]?.cancel()
        self.pendingRunOwnerTasks[runId] = nil
        self.pendingRunOwnerArmIDs[runId] = nil
        if wasPending {
            self.logDiagnostic(
                "chat.ui pending cleared sessionKey=\(self.sessionKey) "
                    + "runId=\(runId)")
            if self.pendingRuns.isEmpty, let hapticEvent {
                self.haptics.perform(hapticEvent)
            }
        }
    }

    func clearPendingRuns(hapticEvent: OpenClawChatHaptics.Event? = nil) {
        let hadPendingRuns = !self.pendingRuns.isEmpty
        for runId in self.pendingRuns {
            self.pendingRunOwnerTasks[runId]?.cancel()
            self.clearLiveRunState(for: runId)
        }
        self.pendingRunOwnerTasks.removeAll()
        self.pendingRunOwnerArmIDs.removeAll()
        self.pendingRuns.removeAll()
        self.pendingLocalUserEchoMessageIDsByRunID.removeAll()
        if hadPendingRuns, let hapticEvent {
            self.haptics.perform(hapticEvent)
        }
    }
}
