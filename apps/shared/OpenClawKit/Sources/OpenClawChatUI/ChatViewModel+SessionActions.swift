import Foundation
import OpenClawKit
import OSLog

private let chatSessionActionsLogger = Logger(
    subsystem: "ai.openclaw",
    category: "OpenClawChat")

/// The immutable gateway route a liveness fact belongs to.
///
/// A presentation alias such as `main` names a different gateway session under
/// each agent, so a latch keyed by the alias alone leaks across agent selection:
/// it would disable the picker for whichever agent is selected next, and let
/// that agent's idle observation retire the original agent's restriction. This
/// reuses the same routed identity `modelPatchTarget` already establishes for
/// model coordination rather than inventing a parallel rule.
///
/// The mutable routing contract is deliberately excluded: it can change while a
/// run is in flight, and an identity that changes underneath a retained fact
/// would strand the latch forever.
struct GatewayRunLivenessIdentity: Hashable {
    let canonicalSessionKey: String
    let agentID: String?
}

/// One server-authoritative statement about a single routed session's liveness,
/// as the source that applied it saw it. Reconciliation consumes these directly
/// so a snapshot about one session can never retire another session's latch.
struct GatewaySessionLivenessObservation {
    let identity: GatewayRunLivenessIdentity
    /// `nil` when the source carried no liveness for this session.
    let hasActiveRun: Bool?
}

extension OpenClawChatViewModel {
    public func deleteSession(_ sessionKey: String, agentID: String? = nil) {
        let target = self.sessionMutationTarget(key: sessionKey, agentID: agentID)
        let transport = self.transport
        let owner = self.sidebarData
        let epoch = owner?.scopeRevision
        let row = self.rosterEntry(key: sessionKey, agentID: target.agentID ?? self.activeAgentId)
        Task {
            do {
                guard let routeLease = await transport.acquireSessionMutationRouteLease() else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                try await routeLease.deleteSession(key: sessionKey, agentID: target.agentID)
            } catch {
                self.errorText = error.localizedDescription
                return
            }
            if let owner {
                guard owner.scopeRevision == epoch else { return }
                if let row { owner.remove(row) }
            } else {
                self.sessions.removeAll { self.sessionMatchesTarget($0, target: target) }
            }
            if self.matchesCurrentSessionKey(incoming: sessionKey, agentId: target.agentID, current: self.sessionKey) {
                // The active transcript just disappeared server-side; fall
                // back to the main session instead of a dead key.
                let fallback = self.resolvedMainSessionKey
                if fallback != self.sessionKey {
                    self.switchSession(to: fallback)
                } else {
                    // Deleting the active main session: the key stays the
                    // address, so clear local state and re-bootstrap in place.
                    self.advanceSessionGeneration()
                    self.clearSessionOwnedState()
                    self.errorText = nil
                    self.load()
                }
            }
            await self.fetchSessions(limit: nil, sessionSnapshot: self.currentSessionSnapshot())
        }
    }

    func sessionMutationTarget(key: String, agentID: String? = nil) -> OpenClawChatSessionTarget {
        let owner = agentID ?? self.rosterEntry(key: key, agentID: self.explicitSessionAgentID ?? self.activeAgentId)?
            .agentId ??
            self.explicitSessionAgentID
        return OpenClawChatSessionTarget(
            sessionKey: key,
            agentID: OpenClawChatSessionKey.agentID(from: key) == nil ? owner : nil)
    }

    func sessionMatchesTarget(_ entry: OpenClawChatSessionEntry, target: OpenClawChatSessionTarget) -> Bool {
        guard entry.key == target.sessionKey else { return false }
        return target.agentID == nil ||
            (entry.agentId ?? self.currentSessionSnapshot().deliveryAgentID) == target.agentID
    }

    func mainSessionKey(for session: OpenClawChatSessionEntry) -> String {
        let agentID = ChatSessionSidebarModel.sidebarAgentID(session) ?? self.selectedAgentID
        return agentID.map { self.mainSessionKey(forAgent: $0) } ?? self.resolvedMainSessionKey
    }

    public var canRequestSessionCompact: Bool {
        !self.isCompacting &&
            !self.isSending &&
            !self.hasBlockingRunActivity &&
            !self.isAborting
    }

    struct SessionBranchSwitchActivity: Equatable {
        let session: SessionSnapshot
        let generation: UInt64
    }

    func beginSessionBranchSwitchActivity(for session: SessionSnapshot) -> SessionBranchSwitchActivity {
        self.nextSessionBranchSwitchGeneration &+= 1
        let activity = SessionBranchSwitchActivity(
            session: session,
            generation: self.nextSessionBranchSwitchGeneration)
        self.sessionBranchSwitchActivity = activity
        return activity
    }

    func isCurrentSessionBranchSwitchActivity(_ activity: SessionBranchSwitchActivity) -> Bool {
        self.sessionBranchSwitchActivity == activity && self.isCurrentSession(activity.session)
    }

    func endSessionBranchSwitchActivity(_ activity: SessionBranchSwitchActivity) {
        guard self.isCurrentSessionBranchSwitchActivity(activity) else { return }
        self.sessionBranchSwitchActivity = nil
        self.flushOutboxIfNeeded()
    }

    var isSwitchingSessionBranch: Bool {
        self.sessionBranchSwitchActivity != nil
    }

    private enum SessionBranchesRefreshPurpose {
        case readOnly
        case reconcile
        case finalizeMutation
    }

    public func refreshSessions(limit: Int? = nil) {
        let context = self.currentSessionSnapshot()
        Task { await self.fetchSessions(limit: limit, sessionSnapshot: context) }
    }

    func generatedNewSessionKey(agentID explicitAgentID: String? = nil) -> String {
        let baseKey = "ios-\(UUID().uuidString.lowercased())"
        guard let agentID = explicitAgentID ??
            OpenClawChatSessionKey.agentID(from: sessionKey) ??
            explicitSessionAgentID ??
            activeAgentId ??
            OpenClawChatSessionKey.agentID(from: resolvedMainSessionKey) ??
            sessions.lazy.compactMap({ OpenClawChatSessionKey.agentID(from: $0.key) }).first
        else {
            return baseKey
        }
        return "agent:\(agentID):\(baseKey)"
    }

    /// Returns true only when a session switch happened (create or reset
    /// fallback); callers keep UI like the new-session popover open on failure.
    @discardableResult
    func performStartNewSession(
        agentID: String? = nil,
        worktree: Bool,
        worktreeBaseRef: String? = nil,
        routeLease: OpenClawChatNewSessionRouteLease? = nil) async -> Bool
    {
        guard !self.isCreatingSession, self.canCreateSessionForImmediateSwitch() else { return false }
        self.isCreatingSession = true
        defer { self.isCreatingSession = false }
        let initiatingSession = self.currentSessionSnapshot()
        let requestedAgentID = ChatPayloadDecoding.trimmedNonEmptyString(agentID)?.lowercased()
        let requested = self.generatedNewSessionKey(agentID: requestedAgentID)
        // Only authoritative identities decide agent ownership; scanning the roster
        // could adopt an unrelated agent and hand sessions.create a cross-agent parent.
        let currentAgentID = (
            OpenClawChatSessionKey.agentID(from: self.sessionKey) ??
                self.explicitSessionAgentID ??
                self.activeAgentId ??
                OpenClawChatSessionKey.agentID(from: self.resolvedMainSessionKey))?
            .lowercased()
        let parentSessionKey = requestedAgentID == nil || requestedAgentID == currentAgentID
            ? self.sessionKey
            : nil
        let next: String
        do {
            let create: OpenClawChatNewSessionRouteLease.CreateSession = if let routeLease {
                routeLease.createSession
            } else {
                self.transport.createSession
            }
            let created = try await create(
                requested,
                nil,
                requestedAgentID,
                parentSessionKey,
                worktree ? true : nil,
                worktree ? worktreeBaseRef : nil)
            let createdKey = created.key.trimmingCharacters(in: .whitespacesAndNewlines)
            next = createdKey.isEmpty ? requested : createdKey
        } catch {
            guard self.isCurrentSession(initiatingSession) else { return false }
            if Self.isUnsupportedCreateSessionError(error) {
                // Reset only mimics a plain new chat; agent/worktree selections were
                // not honored, so advanced requests surface the error instead of
                // silently resetting the current session.
                guard requestedAgentID == nil, !worktree else {
                    chatUILogger.error("sessions.create unsupported; advanced options not honored")
                    self.errorText = error.localizedDescription
                    return false
                }
                guard self.canCreateSessionForImmediateSwitch() else { return false }
                chatUILogger.info("sessions.create unsupported; falling back to sessions.reset")
                await self.performReset()
                return self.isCurrentSession(initiatingSession)
            }
            chatUILogger.error("sessions.create failed \(error.localizedDescription, privacy: .public)")
            self.errorText = error.localizedDescription
            return false
        }
        guard self.isCurrentSession(initiatingSession), self.canCreateSessionForImmediateSwitch() else {
            if !self.sessions.contains(where: { $0.key == next }) { self.refreshSessions() }
            return false
        }
        self.adoptCreatedSession(next)
        return true
    }

    static func isUnsupportedCreateSessionError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "OpenClawChatTransport"
            && nsError.localizedDescription == "sessions.create not supported by this transport"
    }

    @discardableResult
    public func startNewSession(
        agentID: String? = nil,
        worktree: Bool = false,
        worktreeBaseRef: String? = nil) async -> Bool
    {
        await self.performStartNewSession(
            agentID: agentID,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
    }

    @discardableResult
    func startNewSession(
        agentID: String,
        worktree: Bool,
        worktreeBaseRef: String?,
        using routeLease: OpenClawChatNewSessionRouteLease) async -> Bool
    {
        await self.performStartNewSession(
            agentID: agentID,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef,
            routeLease: routeLease)
    }

    func newSessionRouteLease() async throws -> OpenClawChatNewSessionRouteLease {
        guard let routeLease = await self.transport.acquireNewSessionRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return routeLease
    }

    public func fetchSessionGroups() async throws -> [OpenClawChatSessionGroup] {
        let routeLease = try await self.sessionGroupsRouteLease()
        return try await self.fetchSessionGroups(using: routeLease)
    }

    func sessionGroupsRouteLease() async throws -> OpenClawChatSessionGroupsRouteLease {
        guard let routeLease = await self.transport.acquireSessionGroupsRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        return routeLease
    }

    func fetchSessionGroups(
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let response = try await routeLease.listGroups()
        return (response?.groups ?? []).sorted { lhs, rhs in
            lhs.position == rhs.position ? lhs.name < rhs.name : lhs.position < rhs.position
        }
    }

    @discardableResult
    func createSessionGroup(
        named rawName: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return try await self.fetchSessionGroups(using: routeLease) }
        // Read-modify-write matches web group creation (app-sidebar-session-groups,
        // custom-groups); the gateway has no atomic add/CAS. A concurrent edit can
        // lose catalog names/order only — session categories are untouched by
        // sessions.groups.put, so memberships survive. Accepted tradeoff until the
        // gateway grows a revisioned groups API.
        let current = try await self.fetchSessionGroups(using: routeLease)
        let response = try await routeLease.putGroups(current.map(\.name) + [name])
        self.sessionGroupsRevision += 1
        return response.groups
    }

    @discardableResult
    func renameSessionGroup(
        _ name: String,
        to rawName: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let nextName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !nextName.isEmpty else { return try await self.fetchSessionGroups(using: routeLease) }
        let response = try await routeLease.renameGroup(name, nextName)
        self.sessionGroupsRevision += 1
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return response.groups
    }

    @discardableResult
    func deleteSessionGroup(
        _ name: String,
        using routeLease: OpenClawChatSessionGroupsRouteLease) async throws -> [OpenClawChatSessionGroup]
    {
        let response = try await routeLease.deleteGroup(name)
        self.sessionGroupsRevision += 1
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return response.groups
    }

    public func setSessionGroup(key: String, group: String?, agentID: String? = nil) async throws {
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let nextGroup = ChatPayloadDecoding.trimmedNonEmptyString(group)
        let owner = self.sidebarData
        let row = self.rosterEntry(key: key, agentID: target.agentID ?? self.activeAgentId)
        let token = row
            .flatMap { owner?.beginMutation(target: $0, field: .category, update: { $0.category = nextGroup }) }
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        let routeLease = await self.transport.acquireSessionMutationRouteLease()
        guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
        receipt = try await routeLease.patchSession(
            key: key,
            agentID: target.agentID,
            category: .some(nextGroup))
        if owner == nil,
           let index = self.sessions.firstIndex(where: { self.sessionMatchesTarget($0, target: target) })
        {
            self.sessions[index].category = nextGroup
        }
        self.refreshSessions(limit: Self.sessionListFetchLimit)
    }

    func performSessionBatch(
        sessions selectedSessions: [OpenClawChatSessionEntry],
        action: ChatSessionBatchAction) async -> ChatSessionBatchResult
    {
        let orderedKeys = selectedSessions.map(\.key)
        let presentation = self.currentSessionSnapshot()
        let entries = Dictionary(uniqueKeysWithValues: selectedSessions.map { ($0.key, $0) })
        let targets = Dictionary(uniqueKeysWithValues: selectedSessions.map {
            ($0.key, self.sessionMutationTarget(key: $0.key, agentID: $0.agentId))
        })
        let owner = self.sidebarData
        let epoch = owner?.scopeRevision
        // A manager may target another agent without switching the active conversation.
        let mainSessionKeys = entries.mapValues { self.mainSessionKey(for: $0) }
        let attachmentBlockedKeys = self.isAttachmentOwnerPinned
            ? Set(selectedSessions.filter {
                self.matchesCurrentSessionKey(incoming: $0.key, current: self.sessionKey)
            }.map(\.key))
            : []
        let routeLease = await self.transport.acquireSessionMutationRouteLease()
        guard let routeLease else {
            return ChatSessionBatchResult(
                succeededKeys: [],
                errorsByKey: Dictionary(uniqueKeysWithValues: orderedKeys.map {
                    ($0, String(localized: "Gateway changed before the thread operation started."))
                }))
        }
        let result = await ChatSessionBatchMutationRunner.run(keys: orderedKeys) { @MainActor key in
            if let entry = entries[key], let mainSessionKey = mainSessionKeys[key] {
                switch action {
                case .archive where !ChatSessionSidebarModel.canArchiveSession(
                    entry,
                    mainSessionKey: mainSessionKey):
                    throw ChatSessionBatchValidationError.cannotArchive
                case .delete where !ChatSessionSidebarModel.canDeleteSession(
                    key: key,
                    mainSessionKey: mainSessionKey):
                    throw ChatSessionBatchValidationError.cannotDelete
                case .archive where attachmentBlockedKeys.contains(key),
                     .delete where attachmentBlockedKeys.contains(key):
                    throw ChatSessionBatchValidationError.attachmentOwnerPinned
                default:
                    break
                }
            }
            var receipt: OpenClawChatSessionPatchReceipt?
            let token = entries[key].flatMap { owner?.beginBatchMutation(target: $0, action: action) }
            defer { owner?.finishMutation(token, receipt: receipt) }
            switch action {
            case .pin, .unpin:
                receipt = try await routeLease.patchSession(
                    key: key,
                    agentID: targets[key]?.agentID,
                    pinned: action == .pin)
            case .archive:
                guard let expectedSessionID = entries[key]?.sessionId?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                    !expectedSessionID.isEmpty
                else {
                    throw ChatSessionBatchValidationError.cannotArchive
                }
                receipt = try await routeLease.patchSession(
                    key: key,
                    agentID: targets[key]?.agentID,
                    expectedSessionID: expectedSessionID,
                    archived: true)
            case .delete:
                try await routeLease.deleteSession(key: key, agentID: targets[key]?.agentID)
                if owner?.scopeRevision == epoch, let row = entries[key] { owner?.remove(row) }
            }
        }
        let succeeded = Set(result.succeededKeys)
        guard self.isCurrentSession(presentation) else {
            self.refreshSessions(limit: Self.sessionListFetchLimit)
            return result
        }
        switch action {
        case .pin, .unpin:
            let pinned = action == .pin
            for index in self.sessions.indices where owner == nil {
                let entry = self.sessions[index]
                guard succeeded.contains(entry.key), let target = targets[entry.key],
                      self.sessionMatchesTarget(entry, target: target) else { continue }
                self.sessions[index].pinned = pinned
                self.sessions[index].pinnedAt = pinned ? Date().timeIntervalSince1970 * 1000 : nil
            }
            if owner == nil { self.sessions = OpenClawChatSessionListOrganizer.organize(self.sessions) }
        case .archive, .delete:
            if owner == nil {
                self.sessions.removeAll {
                    guard succeeded.contains($0.key), let target = targets[$0.key] else { return false }
                    return self.sessionMatchesTarget($0, target: target)
                }
            }
            if succeeded.contains(where: {
                self.matchesCurrentSessionKey(incoming: $0, agentId: targets[$0]?.agentID, current: self.sessionKey)
            }) {
                self.switchSession(to: self.resolvedMainSessionKey)
            }
        }
        self.refreshSessions(limit: Self.sessionListFetchLimit)
        return result
    }

    public func requestSessionReset() {
        Task { await self.performReset() }
    }

    public func requestSessionCompact() {
        Task { await self.performCompact() }
    }

    public func fetchSessionList(
        search: String?,
        archived: Bool,
        agentID: String? = nil) async -> [OpenClawChatSessionEntry]
    {
        let session = self.currentSessionSnapshot()
        let query = ChatPayloadDecoding.trimmedNonEmptyString(search)
        do {
            let res = try await self.transport.listSessions(
                limit: Self.sessionListFetchLimit,
                search: query,
                archived: archived,
                agentID: agentID ?? session.deliveryAgentID)
            guard self.isCurrentSession(session) else { return [] }
            return OpenClawChatSessionListOrganizer.organize(res.sessions)
        } catch {
            // A superseded (cancelled) fetch must not produce fallback rows;
            // the newer task owns the scoped list. Callers also guard on
            // Task.isCancelled before applying results.
            guard self.isCurrentSession(session), !(error is CancellationError), !Task.isCancelled else { return [] }
            guard !archived else { return [] }
            // sidebar-agent-roster.ts:203 opens management for its agent without changing the conversation.
            let cached = agentID.map { agent in
                (self.sidebarData?.rows ?? self.sessions).filter {
                    !$0.isArchived && ChatSessionSidebarModel.isSessionInActiveAgentScope(
                        key: $0.key,
                        agentID: $0.agentId,
                        activeAgentID: agent)
                }
            } ?? self.sessions
            guard let query else { return cached }
            return OpenClawChatSessionListOrganizer.filter(cached, search: query)
        }
    }

    public func renameSession(key: String, label: String, agentID: String? = nil) {
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let nextLabel = ChatPayloadDecoding.trimmedNonEmptyString(label)
        let row = self.sidebarData?.row(
            key: key,
            agentID: target.agentID ?? self.currentSessionSnapshot().deliveryAgentID)
        self.mutateSessionOptimistically(
            target: target,
            field: .label,
            update: { $0.label = nextLabel
                $0.displayName = nextLabel
            },
            mutation: { routeLease in
                try await routeLease.patchSession(
                    key: key,
                    agentID: target.agentID,
                    expectedSessionID: row?.sessionId,
                    label: .some(nextLabel))
            })
    }

    private func mutateSessionOptimistically(
        target: OpenClawChatSessionTarget,
        field: OpenClawChatSessionSidebarData.Field,
        incarnation: String? = nil,
        update: @escaping (inout OpenClawChatSessionEntry) -> Void,
        mutation: @escaping @MainActor (OpenClawChatSessionMutationRouteLease) async throws
            -> OpenClawChatSessionPatchReceipt?)
    {
        let transport = self.transport
        let presentation = self.currentSessionSnapshot()
        let owner = self.sidebarData
        let previous = owner == nil ? self.sessions : []
        let token = self.rosterEntry(key: target.sessionKey, agentID: target.agentID ?? presentation.deliveryAgentID)
            .flatMap { row in
                incarnation == nil || row.sessionId == incarnation ? owner?.beginMutation(
                    target: row,
                    field: field,
                    update: update) : nil
            }
        if owner == nil {
            self.sessions = self.sessions.compactMap { entry in
                guard self.sessionMatchesTarget(entry, target: target) else { return entry }
                var row = entry
                update(&row)
                return field == .archived && row.isArchived ? nil : row
            }
            if field == .pinned { self.sessions = OpenClawChatSessionListOrganizer.organize(self.sessions) }
        }
        Task {
            do {
                guard let routeLease = await transport.acquireSessionMutationRouteLease() else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                let receipt = try await mutation(routeLease)
                owner?.finishMutation(token, receipt: receipt)
                self.refreshSessions()
            } catch {
                owner?.finishMutation(token, receipt: nil)
                guard self.isCurrentSession(presentation) else { return }
                if owner == nil { self.sessions = self.applyingLocalUnreadOverrides(to: previous) }
                self.errorText = error.localizedDescription
                let failure = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(\(field.rawValue, privacy: .public)) failed \(failure, privacy: .public)")
            }
        }
    }

    public func forkSession(key: String, fromLastCompleted: Bool? = nil, agentID: String? = nil) async {
        guard self.canCreateSessionForImmediateSwitch() else { return }
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let initiatingSession = self.currentSessionSnapshot()
        do {
            let stableBoundary = fromLastCompleted ??
                (self.rosterEntry(key: key, agentID: target.agentID ?? self.activeAgentId)?.hasActiveRun == true)
            let createdKey = try await self.transport.forkSession(
                parentKey: key,
                fromLastCompleted: stableBoundary,
                agentID: target.agentID)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !createdKey.isEmpty else { return }
            guard self.isCurrentSession(initiatingSession), self.canCreateSessionForImmediateSwitch() else {
                self.refreshSessions(limit: Self.sessionListFetchLimit)
                return
            }
            self.switchSession(to: createdKey)
        } catch {
            guard self.isCurrentSession(initiatingSession) else { return }
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.create(fork) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    public func rewindToMessage(_ message: OpenClawChatMessage) async {
        guard let entryID = Self.sessionMutationEntryID(for: message) else { return }
        guard self.canPerformMessageSessionAction else { return }
        let initiatingSession = self.currentSessionSnapshot()
        guard await self.beginOutboxSessionMutation(initiatingSession) else { return }
        guard self.isCurrentSession(initiatingSession) else {
            await self.cancelOutboxSessionMutation(initiatingSession)
            return
        }
        do {
            let result = try await self.transport.rewindSession(
                sessionKey: initiatingSession.key,
                entryId: entryID)
            guard self.isCurrentSession(initiatingSession) else {
                await self.recoverOutboxAfterSessionMutationRefreshFailure(
                    initiatingSession,
                    branchingUnsupported: false)
                return
            }
            self.replyTarget = nil
            self.runMessageScopesByRunID.removeAll()
            self.provisionalFinalMessagesByID.removeAll()
            self.input = result.editorText ?? ""
            self.narration = ChatNarration()
            self.restoreEditorAttachments(result.editorAttachments)
            let historyRequest = self.beginHistoryRequest(for: initiatingSession)
            _ = await self.refreshHistoryAfterRun(historyRequest: historyRequest)
            guard self.isCurrentSession(initiatingSession) else {
                await self.recoverOutboxAfterSessionMutationRefreshFailure(
                    initiatingSession,
                    branchingUnsupported: false)
                return
            }
            await self.refreshSessionBranches(confirmingBranchChange: true)
        } catch {
            await self.cancelOutboxSessionMutation(initiatingSession)
            guard self.isCurrentSession(initiatingSession) else { return }
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.rewind failed \(error.localizedDescription, privacy: .public)")
        }
    }

    @discardableResult
    public func refreshSessionBranches(confirmingBranchChange: Bool = false) async -> Bool {
        let session = self.currentSessionSnapshot()
        let refreshGeneration = self.beginSessionBranchesRefresh()
        let previousState = await self.captureOutboxBranchState(for: session)
        return await self.performSessionBranchesRefresh(
            for: session,
            refreshGeneration: refreshGeneration,
            previousState: previousState,
            purpose: confirmingBranchChange ? .finalizeMutation : .readOnly)
    }

    func refreshSessionBranches(
        for session: SessionSnapshot,
        preBootstrapBranchState: OpenClawChatOutboxBranchState?) async -> Bool
    {
        let refreshGeneration = self.beginSessionBranchesRefresh()
        return await self.performSessionBranchesRefresh(
            for: session,
            refreshGeneration: refreshGeneration,
            previousState: preBootstrapBranchState,
            purpose: .reconcile)
    }

    private func beginSessionBranchesRefresh() -> UInt64 {
        self.sessionBranchesRefreshGeneration &+= 1
        self.isLoadingSessionBranches = true
        return self.sessionBranchesRefreshGeneration
    }

    private func performSessionBranchesRefresh(
        for session: SessionSnapshot,
        refreshGeneration: UInt64,
        previousState: OpenClawChatOutboxBranchState?,
        purpose: SessionBranchesRefreshPurpose) async -> Bool
    {
        let connectionGeneration = self.outboxBranchConnectionGeneration
        defer {
            if self.isCurrentSession(session),
               refreshGeneration == self.sessionBranchesRefreshGeneration
            {
                self.isLoadingSessionBranches = false
            }
        }
        do {
            let response = try await self.requestSessionBranchListing(
                sessionKey: session.key,
                agentID: self.outboxAgentID(for: session))
            guard self.isCurrentSession(session),
                  refreshGeneration == self.sessionBranchesRefreshGeneration,
                  connectionGeneration == self.outboxBranchConnectionGeneration
            else {
                if case .finalizeMutation = purpose {
                    await self.recoverOutboxAfterSessionMutationRefreshFailure(
                        session,
                        branchingUnsupported: false)
                }
                return false
            }
            switch purpose {
            case .readOnly:
                if let outbox = self.outbox,
                   let scope = self.outboxBranchScope(for: session),
                   let expectedEpoch = previousState?.epoch,
                   let activeLeafEntryID = Self.activeBranchLeafEntryID(in: response.branches)
                {
                    _ = await outbox.updateLastActiveLeafEntryID(
                        activeLeafEntryID,
                        expectedEpoch: expectedEpoch,
                        for: scope)
                }
            case .reconcile:
                guard await self.reconcileOutboxBranchScope(
                    session,
                    branches: response.branches,
                    previousState: previousState,
                    connectionGeneration: connectionGeneration)
                else {
                    self.pauseOutboxBranchScope(session)
                    return false
                }
            case .finalizeMutation:
                guard let activeLeafEntryID = Self.activeBranchLeafEntryID(in: response.branches),
                      await self.confirmOutboxBranchChange(
                          session,
                          activeLeafEntryID: activeLeafEntryID)
                else {
                    await self.recoverOutboxAfterSessionMutationRefreshFailure(
                        session,
                        branchingUnsupported: false)
                    return false
                }
            }
            guard self.isCurrentSession(session),
                  refreshGeneration == self.sessionBranchesRefreshGeneration
            else { return false }
            self.sessionBranches = response.branches
            self.flushOutboxIfNeeded()
            return true
        } catch {
            guard self.isCurrentSession(session),
                  refreshGeneration == self.sessionBranchesRefreshGeneration,
                  connectionGeneration == self.outboxBranchConnectionGeneration
            else {
                if case .finalizeMutation = purpose {
                    await self.recoverOutboxAfterSessionMutationRefreshFailure(
                        session,
                        branchingUnsupported: false)
                }
                return false
            }
            chatSessionActionsLogger.debug(
                "sessions.branches.list failed \(error.localizedDescription, privacy: .public)")
            let branchingUnsupported = Self.branchListingIsUnsupported(error)
            switch purpose {
            case .readOnly:
                break
            case .reconcile where branchingUnsupported:
                self.allowOutboxReplayWithoutBranching(session)
            case .reconcile:
                self.pauseOutboxBranchScope(session)
            case .finalizeMutation:
                await self.recoverOutboxAfterSessionMutationRefreshFailure(
                    session,
                    branchingUnsupported: branchingUnsupported)
            }
            return false
        }
    }

    var canSwitchSessionBranch: Bool {
        !self.hasGatewayConfirmedActiveRunForCurrentSession &&
            self.currentSessionEntry()?.hasActiveRun != true &&
            !self.hasBlockingRunActivity &&
            !self.isSending &&
            !self.isAborting &&
            !self.hasUnresolvedOutboxCommandsForCurrentSession
    }

    /// Whether one branch row can start a switch. On iPhone the branch menu is
    /// nested in Composer options, where it renders as a UIKit submenu that has
    /// no disabled state, so the menu-level gate never reaches the user. Each
    /// row therefore carries the same gate itself.
    func canSelectSessionBranch(_ branch: OpenClawChatSessionBranch) -> Bool {
        !branch.active && self.canSwitchSessionBranch
    }

    /// The listed row can be stale — a refresh that never applied leaves the
    /// pre-run entry in place — so the Gateway's own rejection is kept as an
    /// independent liveness fact until the server contradicts it.
    var hasGatewayConfirmedActiveRunForCurrentSession: Bool {
        self.gatewayConfirmedActiveRunIdentities.contains(
            self.gatewayRunLivenessIdentity(for: self.currentSessionSnapshot()))
    }

    /// Resolves the immutable routed identity that owns a session's liveness
    /// facts, so a retained rejection cannot follow a presentation alias onto
    /// another agent. Every source of that state — the rejection itself, idle
    /// lists, lifecycle snapshots, and history — routes through this one
    /// resolver, so no two of them can disagree about which routed session a
    /// liveness fact belongs to.
    func gatewayRunLivenessIdentity(
        forSessionKey sessionKey: String,
        agentID: String?,
        listedKey: String? = nil) -> GatewayRunLivenessIdentity
    {
        let target = self.modelPatchTarget(
            sessionKey: sessionKey,
            canonicalSessionKey: self.canonicalLivenessSessionKey(
                forSessionKey: sessionKey,
                agentID: agentID,
                listedKey: listedKey),
            agentID: agentID,
            // Excluded on purpose: a mutable contract must not change the
            // identity of a fact that is already retained.
            sessionRoutingContract: nil)
        return GatewayRunLivenessIdentity(
            canonicalSessionKey: target.canonicalSessionKey.lowercased(),
            agentID: target.agentID)
    }

    /// The canonical gateway session key a presentation key names.
    ///
    /// `main` is a presentation alias, and a deployment may configure the main
    /// session under a different key: with `mainKey == "work"`, the session the
    /// UI shows as `main` is listed as `agent:<id>:work`. An exact-key lookup
    /// misses that row, so a rejection would retain `agent:<id>:main` while the
    /// idle lists, lifecycle snapshots, and history that read the row reconcile
    /// `agent:<id>:work` — the subtraction would never match and the picker
    /// would stay disabled after the run finished.
    ///
    /// Resolution therefore expands the configured alias before reading
    /// `sessions`, which also yields the same key when the session has no row
    /// at all: a failed or bounded refresh must not change the identity of a
    /// fact that is already retained.
    ///
    /// `listedKey` short-circuits the lookup for callers that already hold the
    /// authoritative row, whose own key is canonical by definition.
    func canonicalLivenessSessionKey(
        forSessionKey sessionKey: String,
        agentID: String?,
        listedKey: String? = nil) -> String
    {
        let presentationKey = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if let listedKey = listedKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !listedKey.isEmpty
        {
            return listedKey
        }
        let canonicalKey = self.expandingConfiguredMainSessionAlias(presentationKey)
        if let listed = self.sessions.first(where: { $0.key == canonicalKey })?.key {
            return listed
        }
        if canonicalKey != presentationKey,
           let listed = self.sessions.first(where: { $0.key == presentationKey })?.key
        {
            return listed
        }
        if let aliased = self.sessions.first(where: {
            Self.matchesCurrentSessionKey(
                incoming: $0.key,
                agentId: $0.agentId,
                current: canonicalKey,
                mainSessionKey: self.resolvedMainSessionKey,
                activeAgentId: agentID ?? self.activeAgentId)
        })?.key {
            return aliased
        }
        // No row: the expanded alias is still the key the Gateway routes by, so
        // an absent session resolves to the identity its row would have carried.
        return canonicalKey
    }

    /// Rewrites a presentation `main` — bare, or as the tail of an
    /// `agent:<id>:main` wrapper — to the configured main session key. Every
    /// other key, and the default `main` configuration, are returned unchanged.
    private func expandingConfiguredMainSessionAlias(_ sessionKey: String) -> String {
        let configuredMainKey = String(
            self.resolvedMainSessionKey
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
                .last ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !configuredMainKey.isEmpty, configuredMainKey.lowercased() != "main" else {
            return sessionKey
        }
        let parts = sessionKey.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        if parts.count == 3, parts[0].lowercased() == "agent" {
            guard parts[2].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "main"
            else {
                return sessionKey
            }
            return "agent:\(parts[1]):\(configuredMainKey)"
        }
        guard sessionKey.lowercased() == "main" else { return sessionKey }
        return configuredMainKey
    }

    func gatewayRunLivenessIdentity(for session: SessionSnapshot) -> GatewayRunLivenessIdentity {
        self.gatewayRunLivenessIdentity(
            forSessionKey: session.key,
            agentID: session.deliveryAgentID ?? session.agentID)
    }

    /// Records the liveness the Gateway asserted when it refused a mutation.
    /// Callers must record before refreshing: a `sessions.list` failure returns
    /// without touching `sessions`, and the stale inactive row would otherwise
    /// re-enable the control into a loop of silently rejected requests.
    func recordGatewayConfirmedActiveRun(for session: SessionSnapshot) {
        self.gatewayConfirmedActiveRunIdentities.insert(
            self.gatewayRunLivenessIdentity(for: session))
    }

    /// Applies a successful `sessions.list` result and reconciles latches
    /// against that same result, so the two cannot drift apart. The list is
    /// authoritative for the rows it returned and silent about any session it
    /// omitted, which therefore keeps its latch. A failed refresh never reaches
    /// here, so it keeps every Gateway-confirmed active run latched.
    func applyListedSessions(_ listed: [OpenClawChatSessionEntry]) {
        self.sessions = self.applyingLocalUnreadOverrides(to: listed)
        self.reconcileGatewayConfirmedActiveRuns(observingListed: listed)
    }

    func reconcileGatewayConfirmedActiveRuns(observingListed listed: [OpenClawChatSessionEntry]) {
        self.reconcileGatewayConfirmedActiveRuns(
            observing: listed.map {
                GatewaySessionLivenessObservation(
                    identity: self.gatewayRunLivenessIdentity(
                        forSessionKey: $0.key,
                        agentID: $0.agentId,
                        listedKey: $0.key),
                    hasActiveRun: $0.hasActiveRun)
            })
    }

    /// Drops latches the server has since contradicted. Call this only right
    /// after applying server-authoritative session liveness, and pass the
    /// observation itself instead of rescanning `sessions`: a single-row
    /// snapshot states nothing about any other session, whose cached row can
    /// still be the stale pre-run entry its latch exists to outlive. An
    /// unknown (`nil`) liveness is not a completion and keeps its latch.
    ///
    /// Matching is exact on the routed identity, so an idle observation for one
    /// agent can never retire a restriction another agent's run established.
    func reconcileGatewayConfirmedActiveRuns(
        observing observations: [GatewaySessionLivenessObservation])
    {
        guard !self.gatewayConfirmedActiveRunIdentities.isEmpty else { return }
        let idleIdentities = Set(
            observations.filter { $0.hasActiveRun == false }.map(\.identity))
        guard !idleIdentities.isEmpty else { return }
        self.gatewayConfirmedActiveRunIdentities.subtract(idleIdentities)
    }

    private nonisolated static func branchSwitchIsBlockedByActiveRun(_ error: Error) -> Bool {
        guard let error = error as? GatewayResponseError else { return false }
        guard error.method == "sessions.branches.switch", error.code == "UNAVAILABLE" else { return false }
        if let reason = error.detailsReason {
            return reason == "session-run-active"
        }
        // Released gateways through v2026.8.x did not include the structured reason.
        return error.message == "Branch switch is unavailable while the agent is working."
    }

    var canPerformMessageSessionAction: Bool {
        !self.hasBlockingRunActivity &&
            !self.isSending &&
            !self.isAborting &&
            !self.hasPendingOutboxCommandsForCurrentSession
    }

    public func switchToBranch(_ leafEntryId: String) async {
        let normalizedLeafEntryID = leafEntryId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedLeafEntryID.isEmpty else { return }
        guard self.canSwitchSessionBranch else { return }
        guard !self.sessionBranches.contains(where: {
            $0.leafEntryId == normalizedLeafEntryID && $0.active
        }) else { return }
        let initiatingSession = self.currentSessionSnapshot()
        let switchActivity = self.beginSessionBranchSwitchActivity(for: initiatingSession)
        defer { self.endSessionBranchSwitchActivity(switchActivity) }
        guard await self.beginOutboxSessionMutation(initiatingSession) else {
            return
        }
        guard self.isCurrentSessionBranchSwitchActivity(switchActivity) else {
            await self.cancelOutboxSessionMutation(initiatingSession)
            return
        }
        do {
            try await self.transport.switchSessionBranch(
                sessionKey: initiatingSession.key,
                agentID: self.outboxAgentID(for: initiatingSession),
                leafEntryId: normalizedLeafEntryID)
            guard self.isCurrentSessionBranchSwitchActivity(switchActivity) else {
                if await self.confirmOutboxBranchChange(
                    initiatingSession,
                    activeLeafEntryID: normalizedLeafEntryID) == false
                {
                    await self.recoverOutboxAfterSessionMutationRefreshFailure(
                        initiatingSession,
                        branchingUnsupported: false)
                }
                return
            }
            self.replyTarget = nil
            self.runMessageScopesByRunID.removeAll()
            self.provisionalFinalMessagesByID.removeAll()
            self.narration = ChatNarration()
            await self.reconcileSessionBranchChange(
                switchActivity,
                confirmedLeafEntryID: normalizedLeafEntryID)
        } catch {
            await self.cancelOutboxSessionMutation(initiatingSession)
            guard self.isCurrentSessionBranchSwitchActivity(switchActivity) else { return }
            if Self.branchSwitchIsBlockedByActiveRun(error) {
                self.recordGatewayConfirmedActiveRun(for: initiatingSession)
                await self.fetchSessions(limit: 50, sessionSnapshot: initiatingSession)
                chatSessionActionsLogger.info(
                    "sessions.branches.switch blocked by active run; refreshed session liveness")
                return
            }
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.branches.switch failed \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Dispatch parity with forkSession(key:): per-request server-lease guards in the
    /// transport plus post-RPC staleness re-checks, not the patch-flow route lease,
    /// which does not expose fork/rewind and would widen the lease API for no sibling.
    public func forkAtMessage(_ message: OpenClawChatMessage) async {
        guard let entryID = Self.sessionMutationEntryID(for: message) else { return }
        guard self.canPerformMessageSessionAction else { return }
        guard self.canCreateSessionForImmediateSwitch() else { return }
        let initiatingSession = self.currentSessionSnapshot()
        guard await self.beginOutboxSessionMutation(initiatingSession) else { return }
        guard self.isCurrentSession(initiatingSession), self.canCreateSessionForImmediateSwitch() else {
            await self.cancelOutboxSessionMutation(initiatingSession)
            return
        }
        do {
            let result = try await self.transport.forkSessionAtMessage(
                sessionKey: initiatingSession.key,
                entryId: entryID)
            // Fork leaves the source transcript unchanged, so its lease is only an entry gate.
            // Rewind repoints the source scope and confirms an epoch change instead.
            await self.cancelOutboxSessionMutation(initiatingSession)
            let createdKey = result.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !createdKey.isEmpty else { return }
            guard self.isCurrentSession(initiatingSession),
                  !self.hasBlockingRunActivity,
                  !self.isSending,
                  !self.isAborting,
                  self.canCreateSessionForImmediateSwitch()
            else {
                self.refreshSessions(limit: Self.sessionListFetchLimit)
                return
            }
            self.switchSession(to: createdKey)
            guard self.sessionKey == createdKey else { return }
            self.input = result.editorText ?? ""
            self.restoreEditorAttachments(result.editorAttachments)
        } catch {
            await self.cancelOutboxSessionMutation(initiatingSession)
            guard self.isCurrentSession(initiatingSession) else { return }
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.fork failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func sessionMutationEntryID(for message: OpenClawChatMessage) -> String? {
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        else { return nil }
        return ChatPayloadDecoding.trimmedNonEmptyString(message.transcriptMessageID)
    }

    public func setSessionUnread(key: String, unread: Bool, agentID: String? = nil) {
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let identityKey = self.sessionMutationIdentity(for: key, agentID: target.agentID)
        let transport = self.transport
        let scopeRevision = self.sidebarData?.scopeRevision
        let owner = self.sidebarData
        let previousEntry = self.rosterEntry(key: key, agentID: target.agentID ?? self.activeAgentId)
        let token = previousEntry.flatMap { owner?.beginMutation(
            target: $0,
            field: .unread,
            update: { $0.unread = unread }) }
        let rollbackUnread = self.unreadPatchGuard.confirmedUnread(key: identityKey) ?? previousEntry?.unread
        let revision = self.unreadPatchGuard.beginExplicitPatch(
            key: identityKey,
            unread: unread,
            isActive: self.matchesCurrentSessionKey(incoming: key, agentId: target.agentID, current: self.sessionKey))
        if owner == nil,
           let index = self.sessions.firstIndex(where: { self.sessionMatchesTarget($0, target: target) })
        {
            self.sessions[index].unread = unread
        }
        let routeLease = Task { await transport.acquireSessionMutationRouteLease() }
        let operation = self.unreadMutationQueue.reserve(
            routeLease: routeLease,
            queueKey: identityKey,
            routeKey: key,
            agentID: target.agentID,
            expectedSessionID: self.sidebarData == nil ? nil : previousEntry?.sessionId,
            unread: unread)
        Task {
            do {
                let receipt = try await operation.value
                owner?.finishMutation(token, receipt: receipt)
                guard self.unreadPatchGuard.patchSucceeded(
                    key: identityKey,
                    unread: unread,
                    revision: revision)
                else { return }
                if unread || !self.applySidebarReadReceipt(
                    receipt,
                    target: previousEntry,
                    scopeRevision: scopeRevision)
                {
                    self.refreshSessions()
                }
            } catch {
                owner?.finishMutation(token, receipt: nil)
                guard self.unreadPatchGuard.patchFailed(key: identityKey, revision: revision) else { return }
                if owner == nil, let index = self.sessions.firstIndex(where: { self.sessionMatchesTarget(
                    $0,
                    target: target) }),
                    self.sessions[index].unread == unread
                {
                    self.sessions[index].unread = rollbackUnread
                }
                self.refreshSessions()
                self.errorText = error.localizedDescription
                chatSessionActionsLogger.error(
                    "sessions.patch(unread) failed \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    public func setSessionColor(key: String, color: String?, agentID: String? = nil) async {
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let owner = self.sidebarData
        let row = self.rosterEntry(key: key, agentID: target.agentID ?? self.activeAgentId)
        let token = row.flatMap { owner?.beginMutation(target: $0, field: .color, update: { $0.color = color }) }
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        do {
            let routeLease = await self.transport.acquireSessionMutationRouteLease()
            guard let routeLease else { throw OpenClawChatTransportSendError.notDispatched }
            receipt = try await routeLease.patchSession(
                key: key,
                agentID: target.agentID,
                color: .some(color))
            self.refreshSessions(limit: Self.sessionListFetchLimit)
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    public func setSessionPinned(key: String, pinned: Bool, agentID: String? = nil) {
        let target = self.sessionMutationTarget(key: key, agentID: agentID)
        let row = self.sidebarData?.row(key: key, agentID: target.agentID ?? self.activeAgentId)
        let pinnedAt = pinned ? Date().timeIntervalSince1970 * 1000 : nil
        self.mutateSessionOptimistically(
            target: target,
            field: .pinned,
            update: { $0.pinned = pinned
                $0.pinnedAt = pinnedAt
                if pinned {
                    $0.snoozedUntil = nil
                    $0.snoozedAt = nil
                }
            },
            mutation: { routeLease in
                try await routeLease.patchSession(
                    key: key,
                    agentID: target.agentID,
                    expectedSessionID: row?.sessionId,
                    pinned: pinned)
            })
    }

    public func setSessionArchived(_ session: OpenClawChatSessionEntry, archived: Bool) {
        let key = session.key
        let target = self.sessionMutationTarget(key: key, agentID: session.agentId)
        guard archived else {
            Task { await self.restoreSession(session) }
            return
        }
        guard let expectedSessionID = ChatPayloadDecoding.trimmedNonEmptyString(session.sessionId) else {
            self.errorText = "Session lifecycle action requires a durable session identity."
            return
        }
        self.mutateSessionOptimistically(
            target: target,
            field: .archived,
            incarnation: session.sessionId,
            update: { $0.archived = true
                $0.pinned = false
                $0.pinnedAt = nil
                $0.snoozedUntil = nil
                $0.snoozedAt = nil
            },
            mutation: { routeLease in
                let receipt = try await routeLease.patchSession(
                    key: key,
                    agentID: target.agentID,
                    expectedSessionID: expectedSessionID,
                    archived: true)
                if self.matchesCurrentSessionKey(incoming: key, agentId: target.agentID, current: self.sessionKey) {
                    // The archived session rejects new sends; return to the main session.
                    self.switchSession(to: self.resolvedMainSessionKey)
                }
                return receipt
            })
    }

    /// Restores an archived session. Returns false (with `errorText` set) on
    /// failure so open-flows can avoid switching into a still-archived session.
    @discardableResult
    public func restoreSession(_ session: OpenClawChatSessionEntry) async -> Bool {
        let target = self.sessionMutationTarget(key: session.key, agentID: session.agentId)
        guard let expectedSessionID = ChatPayloadDecoding.trimmedNonEmptyString(session.sessionId) else {
            self.errorText = "Session lifecycle action requires a durable session identity."
            return false
        }
        let owner = self.sidebarData
        let token = owner?.beginMutation(target: session, field: .archived, update: { $0.archived = false
            $0.archivedAt = nil
        })
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        do {
            guard let routeLease = await self.transport.acquireSessionMutationRouteLease() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            receipt = try await routeLease.patchSession(
                key: session.key,
                agentID: target.agentID,
                expectedSessionID: expectedSessionID,
                archived: false)
            self.refreshSessions()
            return true
        } catch {
            self.errorText = error.localizedDescription
            chatSessionActionsLogger.error(
                "sessions.patch(archived=false) failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func markCurrentSessionReadAfterActivation(
        _ session: SessionSnapshot,
        fallbackEntry: OpenClawChatSessionEntry?) async
    {
        guard self.isCurrentSession(session), self.hasAppliedLiveHistory,
              let entry = self.currentSessionEntry() ?? fallbackEntry,
              let revision = self.unreadPatchGuard.shouldPatch(
                  key: self.sessionMutationIdentity(for: entry.key, listedKey: entry.key, agentID: entry.agentId),
                  unread: entry.unread,
                  markedUnreadAt: entry.markedUnreadAt)
        else { return }
        let identityKey = self.sessionMutationIdentity(for: entry.key, listedKey: entry.key, agentID: entry.agentId)
        let target = self.sessionMutationTarget(key: entry.key, agentID: entry.agentId)
        let transport = self.transport
        let scopeRevision = self.sidebarData?.scopeRevision
        let routeLease = Task { await transport.acquireSessionMutationRouteLease() }
        let operation = self.unreadMutationQueue.reserve(
            routeLease: routeLease,
            queueKey: identityKey,
            routeKey: entry.key,
            agentID: target.agentID,
            expectedMarkedUnreadAt: .some(entry.markedUnreadAt),
            expectedSessionID: self.sidebarData == nil ? nil : entry.sessionId,
            unread: false)
        do {
            let receipt = try await operation.value
            guard self.unreadPatchGuard.patchSucceeded(
                key: identityKey,
                unread: false,
                revision: revision)
            else { return }
            if !self.applySidebarReadReceipt(receipt, target: entry, scopeRevision: scopeRevision) {
                self.refreshSessions()
            }
        } catch {
            guard self.unreadPatchGuard.patchFailed(key: identityKey, revision: revision) else { return }
            chatSessionActionsLogger.error(
                "sessions.patch(unread=false) failed \(error.localizedDescription, privacy: .public)")
        }
    }
}
