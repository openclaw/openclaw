import Foundation
import Observation
import OpenClawKit
import OSLog

private let chatUILogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

@MainActor
@Observable
// swiftlint:disable:next type_body_length
public final class OpenClawChatViewModel {
    public static let defaultModelSelectionID = "__default__"
    static let maxAttachmentBytes = 5_000_000

    public internal(set) var messages: [OpenClawChatMessage] = []

    public var input: String = ""
    public private(set) var thinkingLevel: String
    /// Setter is module-internal for the thinking-level extension only.
    public internal(set) var thinkingLevelOptions: [OpenClawChatThinkingLevelOption]
    public private(set) var modelSelectionID: String = "__default__"
    public private(set) var modelChoices: [OpenClawChatModelChoice] = []
    public private(set) var slashCommands: [OpenClawChatCommandChoice] = []
    public private(set) var isLoadingSlashCommands = false
    public private(set) var slashCommandsErrorText: String?
    public private(set) var hasLoadedSlashCommands = false
    @ObservationIgnored
    private var slashFilterCache: SlashFilterCache?

    private struct SlashFilterCache {
        let query: String
        let filter: OpenClawChatCommandFilter
        let result: [OpenClawChatCommandChoice]
    }

    public private(set) var isLoading = false
    public private(set) var isSending = false
    public private(set) var isAborting = false
    public var errorText: String?
    public var attachments: [OpenClawPendingAttachment] = []
    /// Setter is module-internal for the health/outbox extension only.
    public internal(set) var healthOK: Bool = false
    public private(set) var pendingRunCount: Int = 0

    public private(set) var sessionKey: String
    public private(set) var sessionId: String?
    public private(set) var streamingAssistantText: String?

    public private(set) var pendingToolCalls: [OpenClawChatPendingToolCall] = []

    private(set) var timelineRevision: UInt64 = 0
    /// Setter is module-internal for the transcript-cache extension only.
    public internal(set) var sessions: [OpenClawChatSessionEntry] = []
    /// True while the visible transcript came from the offline cache and no
    /// live history response has replaced it yet (possibly stale).
    public internal(set) var isShowingCachedTranscript = false
    /// Guard the cache pre-paint: once a live response applied (even an empty
    /// one), a slow cache read must never paint stale rows over it.
    var hasAppliedLiveHistory = false
    var hasAppliedLiveSessions = false
    /// Internal for the outbox extension's flush path only.
    let transport: any OpenClawChatTransport
    let haptics: OpenClawChatHaptics
    let transcriptCache: (any OpenClawChatTranscriptCache)?
    let outbox: (any OpenClawChatCommandOutbox)?
    /// Per-message outbox display state; rows without an entry are normal
    /// transcript rows. Observable so bubbles update when flush progresses.
    public internal(set) var outboxStatesByMessageID: [UUID: OpenClawChatOutboxMessageState] = [:]
    @ObservationIgnored
    var outboxCommandIDsByMessageID: [UUID: String] = [:]
    @ObservationIgnored
    var outboxMessageIDsByCommandID: [String: UUID] = [:]
    @ObservationIgnored
    var isFlushingOutbox = false
    @ObservationIgnored
    var isOutboxFlushRequestedWhileActive = false
    @ObservationIgnored
    var hasRecoveredInterruptedOutboxSends = false
    /// Tombstones set synchronously on user delete so an active flush pass
    /// never sends a command whose bubble the user just removed.
    @ObservationIgnored
    var deletedOutboxCommandIDs: Set<String> = []
    /// Backoff between failed flush attempts; internal so tests can shorten it.
    @ObservationIgnored
    var outboxRetryDelaysMs: [UInt64] = [2000, 8000]
    /// Consecutive transport-level flush failures. Paces retries up the
    /// delay ladder without touching the durable per-command retryCount
    /// (reserved for gateway verdicts); past the ladder, health drops and
    /// the reconnect machinery owns pacing.
    @ObservationIgnored
    var outboxTransportFailureStreak = 0
    /// User idempotency keys of turns just flushed from the outbox whose
    /// durable outbox row is already deleted but which no history snapshot
    /// has confirmed yet. Reconciliation must not evict them: the gateway
    /// history can lag the ack, and eviction here would drop the turn from
    /// both the screen and the write-through cache. Drained when a snapshot
    /// contains the key; bounded because every flush drains or session
    /// switches clear it.
    @ObservationIgnored
    var recentlySentOutboxUserKeys: Set<String> = []
    /// False until restoreOutboxMessages has adopted durable rows for the
    /// visible session. Until then the in-memory outbox state is blind to
    /// rows persisted by an earlier process, so the FIFO send gate must
    /// assume a backlog exists.
    @ObservationIgnored
    var hasRestoredOutboxMessages = false
    @ObservationIgnored
    nonisolated(unsafe) var outboxRetryTask: Task<Void, Never>?
    /// A command becomes terminally 'failed' after this many send attempts.
    nonisolated static let maxOutboxSendAttempts = 3
    @ObservationIgnored
    var pendingCacheWriteTask: Task<Void, Never>?
    private(set) var activeAgentId: String?
    var sessionDefaults: OpenClawChatSessionsDefaults?
    private let prefersExplicitThinkingLevel: Bool
    private let onSessionChanged: (@MainActor (String) -> Void)?
    private let onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)?
    private let diagnosticsLog: (@MainActor @Sendable (String) -> Void)?

    @ObservationIgnored
    private nonisolated(unsafe) var eventTask: Task<Void, Never>?
    @ObservationIgnored
    private nonisolated(unsafe) var bootstrapTask: Task<Void, Never>?
    private var runOwnershipGeneration: UInt64 = 0
    private var latestAppliedRunSnapshotRequestID: UInt64 = 0
    private var isApplyingRunSnapshot = false
    var pendingRuns = Set<String>() {
        didSet {
            if self.pendingRuns != oldValue, !self.isApplyingRunSnapshot {
                self.runOwnershipGeneration &+= 1
            }
            let nextCount = self.pendingRuns.count
            guard nextCount != self.pendingRunCount else { return }
            self.pendingRunCount = nextCount
            self.markTimelineChanged()
        }
    }

    var pendingLocalUserEchoMessageIDsByRunID: [String: UUID] = [:]
    // Final chat events and durable session-message rows arrive independently.
    // Keep each provisional final scoped to the run's user turn so a later identical
    // answer in the same session does not adopt or suppress the wrong row.
    var runMessageScopesByRunID: [String: RunMessageScope] = [:]
    var provisionalFinalMessagesByID: [UUID: ProvisionalFinalMessage] = [:]
    private var sessionGeneration: UInt64 = 0
    private var bootstrapGeneration: UInt64 = 0
    // A newer same-session history request only invalidates older responses after it applies.
    // Failed later refreshes must not drop the last successful pending-run history payload.
    private var lastIssuedHistoryRequestID: UInt64 = 0
    private var latestAppliedHistoryRequestID: UInt64 = 0
    private var historyMutationGeneration: UInt64 = 0

    @ObservationIgnored
    private nonisolated(unsafe) var pendingRunTimeoutTasks: [String: Task<Void, Never>] = [:]
    private var nextPendingRunTimeoutArmID: UInt64 = 0
    private var pendingRunTimeoutArmIDs: [String: UInt64] = [:]
    private let pendingRunTimeoutMs: UInt64 = 120_000
    private static let postSendRefreshDelaysMs: [UInt64] = [
        1500,
        4000,
        9000,
        20000,
        45000,
        90000,
    ]
    // Session switches can overlap in-flight picker patches, so stale completions
    // must compare against the latest request and latest desired value for that session.
    private var nextModelSelectionRequestID: UInt64 = 0
    private var latestModelSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestModelSelectionIDsBySession: [String: String] = [:]
    private var lastSuccessfulModelSelectionIDsBySession: [String: String] = [:]
    private var inFlightModelPatchCountsBySession: [String: Int] = [:]
    private var modelPatchWaitersBySession: [String: [CheckedContinuation<Void, Never>]] = [:]
    private var nextThinkingSelectionRequestID: UInt64 = 0
    private var latestThinkingSelectionRequestIDsBySession: [String: UInt64] = [:]
    private var latestThinkingLevelsBySession: [String: String] = [:]
    private var isCompacting = false
    private var lastCompactAt: Date?
    private let compactCooldown: TimeInterval = 60

    private enum SessionSwitchIntent {
        case userInitiated
        case externalSync
    }

    private struct BootstrapContext {
        var id: UInt64
        var historyRequest: HistoryRequest

        var session: SessionSnapshot {
            self.historyRequest.session
        }
    }

    private struct HistoryRequest {
        var id: UInt64
        var session: SessionSnapshot
        var pendingRunIDs: Set<String>
        var visibleMessagesByID: [UUID: OpenClawChatMessage]
        var historyMutationGeneration: UInt64
        var runOwnershipGeneration: UInt64
        var latestUserTurn: LatestUserTurn?
    }

    struct LatestUserTurn {
        var idempotencyKey: String?
        var refreshKey: String?
        var occurrence: Int
        var timestamp: Double?
    }

    struct RunMessageScope {
        var session: SessionSnapshot
        var latestUserTurn: LatestUserTurn?
    }

    struct ProvisionalFinalMessage {
        var reconciliationKey: String
        var runId: String?
        var scope: RunMessageScope
    }

    private var pendingToolCallsById: [String: OpenClawChatPendingToolCall] = [:] {
        didSet {
            guard self.pendingToolCallsById != oldValue else { return }
            self.pendingToolCalls = self.pendingToolCallsById.values
                .sorted { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }
            self.markTimelineChanged()
        }
    }

    var lastHealthPollAt: Date?

    public init(
        sessionKey: String,
        transport: any OpenClawChatTransport,
        activeAgentId: String? = nil,
        haptics: OpenClawChatHaptics = OpenClawChatHaptics(),
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil,
        initialThinkingLevel: String? = nil,
        onSessionChanged: (@MainActor (String) -> Void)? = nil,
        onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil,
        diagnosticsLog: (@MainActor @Sendable (String) -> Void)? = nil)
    {
        self.sessionKey = sessionKey
        self.transport = transport
        self.haptics = haptics
        self.transcriptCache = transcriptCache
        let normalizedAgentId = activeAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.activeAgentId = normalizedAgentId?.isEmpty == false ? normalizedAgentId : nil
        self.outbox = outbox
        let normalizedThinkingLevel = Self.normalizedThinkingLevel(initialThinkingLevel)
        let initialResolvedThinkingLevel = normalizedThinkingLevel ?? "off"
        self.thinkingLevel = initialResolvedThinkingLevel
        self.thinkingLevelOptions = Self.withCurrentThinkingOption(
            Self.baseThinkingLevelOptions,
            current: initialResolvedThinkingLevel)
        self.prefersExplicitThinkingLevel = normalizedThinkingLevel != nil
        self.onSessionChanged = onSessionChanged
        self.onThinkingLevelChanged = onThinkingLevelChanged
        self.diagnosticsLog = diagnosticsLog

        let transport = self.transport
        self.eventTask = Task { [weak self, transport] in
            let stream = transport.events()
            for await evt in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handleTransportEvent(evt)
                }
            }
        }
    }

    deinit {
        self.eventTask?.cancel()
        self.bootstrapTask?.cancel()
        self.outboxRetryTask?.cancel()
        for (_, task) in self.pendingRunTimeoutTasks {
            task.cancel()
        }
    }

    public func load() {
        self.startBootstrap()
    }

    public func refresh() {
        self.startBootstrap()
    }

    public func resumeFromForeground() {
        Task { await self.refreshRunStateAfterForeground() }
    }

    public func send() {
        self.logDiagnostic(
            "chat.ui send invoked sessionKey=\(self.sessionKey) "
                + "inputLen=\(self.input.count) attachments=\(self.attachments.count) "
                + "pending=\(self.pendingRunCount) sending=\(self.isSending) "
                + "health=\(self.healthOK)")
        Task { await self.performSend() }
    }

    public func abort() {
        Task { await self.performAbort() }
    }

    public func refreshSessions(limit: Int? = nil) {
        let context = self.currentSessionSnapshot()
        Task { await self.fetchSessions(limit: limit, sessionSnapshot: context) }
    }

    public func startNewSession(worktree: Bool = false) async {
        await self.performStartNewSession(worktree: worktree)
    }

    public func switchSession(to sessionKey: String) {
        self.applySessionSwitch(to: sessionKey, intent: .userInitiated)
    }

    public func syncSession(to sessionKey: String) {
        self.applySessionSwitch(to: sessionKey, intent: .externalSync)
    }

    public func syncActiveAgentId(_ agentId: String?) {
        let normalized = agentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let nextAgentId = normalized?.isEmpty == false ? normalized : nil
        guard self.activeAgentId != nextAgentId else { return }
        self.activeAgentId = nextAgentId
        let normalizedSessionKey = self.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedMainSessionKey = self.resolvedMainSessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalizedSessionKey == "global" ||
            normalizedSessionKey == "main" ||
            normalizedSessionKey == normalizedMainSessionKey
        else {
            return
        }
        // Main aliases belong to the configured default agent. Changing that
        // identity changes their transcript owner, so no old request or row may cross it.
        self.advanceSessionGeneration()
        self.clearSessionOwnedState()
        self.startBootstrap()
    }

    public func selectThinkingLevel(_ level: String) {
        Task { await self.performSelectThinkingLevel(level) }
    }

    public func selectModel(_ selectionID: String) {
        Task { await self.performSelectModel(selectionID) }
    }

    public func loadSlashCommandsIfNeeded() {
        guard self.transport.supportsSlashCommandCatalog else { return }
        guard !self.hasLoadedSlashCommands, !self.isLoadingSlashCommands else { return }
        Task { await self.loadSlashCommands(force: false) }
    }

    public func refreshSlashCommands() {
        guard self.transport.supportsSlashCommandCatalog else { return }
        Task { await self.loadSlashCommands(force: true) }
    }

    public func slashCommandMatches(
        query: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        if let cache = self.slashFilterCache, cache.query == query, cache.filter == filter {
            return cache.result
        }
        let result = Self.filteredSlashCommands(self.slashCommands, query: query, filter: filter)
        self.slashFilterCache = SlashFilterCache(query: query, filter: filter, result: result)
        return result
    }

    public func applySlashCommandSelection(_ command: OpenClawChatCommandChoice) {
        let invocation = command.preferredInvocation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !invocation.isEmpty else { return }
        self.input = command.acceptsArgs ? "\(invocation) " : invocation
        self.errorText = nil
    }

    var resolvedMainSessionKey: String {
        let trimmed = self.sessionDefaults?.mainSessionKey?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false ? trimmed : nil) ?? "main"
    }

    public var showsModelPicker: Bool {
        !self.modelChoices.isEmpty
    }

    public var defaultModelLabel: String {
        guard let defaultModelID = normalizedModelSelectionID(sessionDefaults?.model) else {
            return "Default"
        }
        return "Default: \(self.modelLabel(for: defaultModelID))"
    }

    static let baseThinkingLevelOptions: [OpenClawChatThinkingLevelOption] = [
        OpenClawChatThinkingLevelOption(id: "off", label: "off"),
        OpenClawChatThinkingLevelOption(id: "minimal", label: "minimal"),
        OpenClawChatThinkingLevelOption(id: "low", label: "low"),
        OpenClawChatThinkingLevelOption(id: "medium", label: "medium"),
        OpenClawChatThinkingLevelOption(id: "high", label: "high"),
    ]

    public func addAttachments(urls: [URL]) {
        Task { await self.loadAttachments(urls: urls) }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        Task { await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType) }
    }

    public func removeAttachment(_ id: OpenClawPendingAttachment.ID) {
        self.attachments.removeAll { $0.id == id }
    }

    public var canSend: Bool {
        !self.isSending && self.pendingRunCount == 0 && self.hasDraftToSend
    }

    public var hasDraftToSend: Bool {
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty || !self.attachments.isEmpty
    }

    public var canSendDraft: Bool {
        !self.isSending && self.hasDraftToSend
    }

    // MARK: - Internals

    func markTimelineChanged() {
        self.timelineRevision &+= 1
    }

    private func appendMessage(_ message: OpenClawChatMessage) {
        self.messages.append(message)
        self.markTimelineChanged()
    }

    private func removeMessage(id: UUID) {
        let previousCount = self.messages.count
        self.messages.removeAll { $0.id == id }
        if self.messages.count != previousCount {
            self.markTimelineChanged()
        }
    }

    private func updateStreamingAssistantText(_ text: String?) {
        guard self.streamingAssistantText != text else { return }
        self.streamingAssistantText = text
        self.markTimelineChanged()
    }

    private func logDiagnostic(_ message: String) {
        self.diagnosticsLog?(message)
    }

    func currentSessionSnapshot() -> SessionSnapshot {
        SessionSnapshot(key: self.sessionKey, generation: self.sessionGeneration)
    }

    func isCurrentSession(_ snapshot: SessionSnapshot) -> Bool {
        self.sessionKey == snapshot.key && self.sessionGeneration == snapshot.generation
    }

    private func isCurrentBootstrap(_ context: BootstrapContext) -> Bool {
        self.bootstrapGeneration == context.id && self.isCurrentSession(context.session)
    }

    private func canApplyHistory(_ request: HistoryRequest) -> Bool {
        request.id >= self.latestAppliedHistoryRequestID &&
            self.isCurrentSession(request.session)
    }

    private func advanceSessionGeneration() {
        self.sessionGeneration &+= 1
    }

    private func invalidateRunSnapshots() {
        self.runOwnershipGeneration &+= 1
    }

    private func invalidateHistorySnapshots() {
        self.historyMutationGeneration &+= 1
    }

    private func beginHistoryRequest(
        for sessionSnapshot: SessionSnapshot? = nil,
        captureLatestUserTurn: Bool = true) -> HistoryRequest
    {
        self.lastIssuedHistoryRequestID &+= 1
        return HistoryRequest(
            id: self.lastIssuedHistoryRequestID,
            session: sessionSnapshot ?? self.currentSessionSnapshot(),
            pendingRunIDs: self.pendingRuns,
            visibleMessagesByID: Dictionary(uniqueKeysWithValues: self.messages.map { ($0.id, $0) }),
            historyMutationGeneration: self.historyMutationGeneration,
            runOwnershipGeneration: self.runOwnershipGeneration,
            latestUserTurn: captureLatestUserTurn ? Self.latestUserTurn(in: self.messages) : nil)
    }

    private func markHistoryRequestApplied(_ request: HistoryRequest) {
        self.latestAppliedHistoryRequestID = max(self.latestAppliedHistoryRequestID, request.id)
    }

    @discardableResult
    private func applyHistoryPayload(
        _ payload: OpenClawChatHistoryPayload,
        for request: HistoryRequest,
        preservingOptimisticLocalMessages: Bool,
        syncThinkingOptions: Bool = false) -> Bool
    {
        guard self.canApplyHistory(request) else { return false }
        let incoming = self.adoptingProvisionalFinalMessageIDs(
            in: Self.decodeMessages(payload.messages ?? []))
        let unmatchedProvisionalFinalIDs = Set(self.provisionalFinalMessagesMissing(from: incoming).map(\.id))
        var retainedMessageIDs = unmatchedProvisionalFinalIDs
        if request.historyMutationGeneration != self.historyMutationGeneration {
            for message in self.messages where request.visibleMessagesByID[message.id] != message {
                let isMatchedProvisional = self.provisionalFinalMessagesByID[message.id] != nil &&
                    !unmatchedProvisionalFinalIDs.contains(message.id)
                if !isMatchedProvisional {
                    retainedMessageIDs.insert(message.id)
                }
            }
        }
        var nextMessages = if preservingOptimisticLocalMessages {
            Self.reconcileRunRefreshMessages(
                previous: self.messages,
                incoming: incoming,
                pendingLocalUserEchoIDs: Set(self.pendingLocalUserEchoMessageIDsByRunID.values))
        } else {
            Self.reconcileMessageIDs(previous: self.messages, incoming: incoming)
        }
        // Ack-to-history window: turns just flushed from the outbox may not
        // be in this snapshot yet. Their durable rows are gone, so keep the
        // visible rows (appended: they are the newest turns) until a
        // snapshot carries their idempotency key.
        if !self.recentlySentOutboxUserKeys.isEmpty {
            self.recentlySentOutboxUserKeys.subtract(incoming.compactMap(\.idempotencyKey))
            let nextKeys = Set(nextMessages.compactMap(\.idempotencyKey))
            let preserved = self.messages.filter { message in
                guard let key = message.idempotencyKey else { return false }
                return self.recentlySentOutboxUserKeys.contains(key) && !nextKeys.contains(key)
            }
            nextMessages.append(contentsOf: preserved)
        }
        let reconciledMessageIDs = Set(nextMessages.map(\.id))
        nextMessages.append(contentsOf: self.messages.filter { message in
            retainedMessageIDs.contains(message.id) && !reconciledMessageIDs.contains(message.id)
        })
        self.replaceMessages(Self.dedupeMessages(nextMessages))
        self.prunePendingLocalUserEchoMessageIDs()
        self.clearProvisionalFinalMarkersAdoptedByHistory(incoming)
        self.pruneProvisionalFinalMessages()
        self.pruneRunMessageScopes()
        self.rescopeRunsAdoptedAfterHistoryRequest(request)
        self.sessionId = payload.sessionId
        self.applyInFlightRunSnapshot(payload.inFlightRun, for: request)
        // Incomplete refreshes can arrive before durable assistant history.
        // The latest visible user turn must survive answered before it can reject older replies.
        let canInvalidateOlderHistory = if let latestUserTurn = request.latestUserTurn {
            Self.hasAnsweredUser(latestUserTurn, in: self.messages)
        } else {
            !Self.hasUnansweredLatestUser(in: self.messages)
        }
        if canInvalidateOlderHistory {
            self.markHistoryRequestApplied(request)
        }
        let appliedThinkingLevel = !self.prefersExplicitThinkingLevel
            ? Self.normalizedThinkingLevel(payload.thinkingLevel)
            : nil
        if let level = appliedThinkingLevel {
            self.thinkingLevel = level
        }
        if syncThinkingOptions || appliedThinkingLevel != nil {
            self.syncThinkingLevelOptions()
        }
        // Live history is the source of truth: it clears the cached marker and
        // is written through so the next cold open pre-paints current rows.
        self.hasAppliedLiveHistory = true
        self.isShowingCachedTranscript = false
        // An empty post-send refresh is incomplete by contract: reconciliation
        // preserves the visible transcript, so preserve its last canonical cache too.
        if !preservingOptimisticLocalMessages || !incoming.isEmpty {
            // Persist the RECONCILED transcript, not raw incoming: a stale
            // snapshot missing a just-acked turn must not overwrite the
            // cache after the durable outbox row is already gone — the cache
            // mirrors what the user sees.
            self.persistTranscriptToCache(sessionKey: request.session.key, messages: nextMessages)
        }
        // Wholesale history replacement drops local-only queued bubbles;
        // re-adopt or re-append them from the durable outbox.
        self.restoreOutboxMessages(session: request.session)
        return true
    }

    private func provisionalFinalMessagesMissing(
        from incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        let incomingRunIds = Set(incoming.compactMap { Self.normalizedIdempotencyKey($0.idempotencyKey) })
        return self.messages.filter { message in
            guard let provisional = provisionalFinalMessagesByID[message.id] else { return false }
            if let runId = provisional.runId, incomingRunIds.contains(runId) {
                return false
            }
            guard Self.containsUserTurn(provisional.scope.latestUserTurn, in: incoming) else {
                return true
            }
            let searchRange = Self.messageRange(after: provisional.scope.latestUserTurn, in: incoming)
            return !incoming[searchRange].contains { incomingMessage in
                Self.finalMessageReconciliationKey(for: incomingMessage) == provisional.reconciliationKey
            }
        }
    }

    private func rescopeRunsAdoptedAfterHistoryRequest(_ request: HistoryRequest) {
        for runId in self.pendingRuns {
            let scope = self.runMessageScopesByRunID[runId]
            if !request.pendingRunIDs.contains(runId) || scope?.latestUserTurn == nil {
                self.runMessageScopesByRunID[runId] = self.currentRunMessageScope()
            }
        }
    }

    private func applyInFlightRunSnapshot(
        _ snapshot: OpenClawChatInFlightRun?,
        for request: HistoryRequest)
    {
        guard request.runOwnershipGeneration == self.runOwnershipGeneration,
              request.id >= self.latestAppliedRunSnapshotRequestID
        else {
            return
        }
        self.latestAppliedRunSnapshotRequestID = request.id
        guard let snapshot,
              let runId = Self.normalizedRunID(snapshot.runId)
        else {
            return
        }

        self.isApplyingRunSnapshot = true
        defer { self.isApplyingRunSnapshot = false }
        self.adoptRun(runId: runId, bufferedText: snapshot.text)
    }

    private func adoptRun(runId: String, bufferedText: String) {
        let canonicalPendingRuns = Set([runId])
        if self.pendingRuns != canonicalPendingRuns {
            // Gateway snapshots and live deltas are canonical for this session.
            // Replace stale local ownership so only that run consumes later events.
            self.clearPendingRuns(reason: nil)
            self.pendingRuns.insert(runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
        }
        if self.runMessageScopesByRunID[runId] == nil {
            self.runMessageScopesByRunID[runId] = self.currentRunMessageScope()
        }
        self.armPendingRunTimeout(runId: runId)
        if !bufferedText.isEmpty {
            self.updateStreamingAssistantText(bufferedText)
        }
        self.logDiagnostic(
            "chat.ui adopted in-flight run sessionKey=\(self.sessionKey) "
                + "runId=\(runId) bufferedTextLen=\(bufferedText.count)")
    }

    private func startBootstrap(sessionKey requestedSessionKey: String? = nil) {
        let sessionKey = requestedSessionKey ?? self.sessionKey
        guard sessionKey == self.sessionKey else { return }
        self.bootstrapGeneration &+= 1
        self.bootstrapTask?.cancel()
        self.isLoading = true
        self.errorText = nil
        self.healthOK = false
        self.clearPendingRuns(reason: nil)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.sessionId = nil
        let historyRequest = self.beginHistoryRequest(captureLatestUserTurn: requestedSessionKey == nil)
        let context = BootstrapContext(
            id: bootstrapGeneration,
            historyRequest: historyRequest)
        self.paintFromCacheIfNeeded(session: context.session)
        self.restoreOutboxMessages(session: context.session)
        self.bootstrapTask = Task { [weak self] in
            guard let self else { return }
            await self.bootstrap(context: context)
        }
    }

    private func bootstrap(context: BootstrapContext) async {
        guard self.isCurrentBootstrap(context) else { return }
        defer {
            if self.isCurrentBootstrap(context) {
                self.isLoading = false
            }
        }
        do {
            await self.syncActiveSessionSubscription(startingWith: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }

            let payload = try await transport.requestHistory(sessionKey: context.session.key)
            guard self.isCurrentBootstrap(context) else { return }
            _ = self.applyHistoryPayload(
                payload,
                for: context.historyRequest,
                preservingOptimisticLocalMessages: false,
                syncThinkingOptions: true)
            await self.pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            await self.fetchSessions(limit: 50, sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            await self.fetchModels(sessionSnapshot: context.session)
            guard self.isCurrentBootstrap(context) else { return }
            self.errorText = nil
        } catch {
            guard self.isCurrentBootstrap(context) else { return }
            self.errorText = error.localizedDescription
            chatUILogger.error("bootstrap failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func syncActiveSessionSubscription(startingWith sessionKey: String) async {
        var nextSessionKey = sessionKey
        while true {
            do {
                // Subscribe requests are gateway side effects. If a stale request finishes
                // after a newer switch, immediately reassert the latest visible session.
                try await self.transport.setActiveSessionKey(nextSessionKey)
            } catch {
                let currentSessionKey = self.sessionKey
                guard currentSessionKey != nextSessionKey else {
                    // Best-effort only; history/send/health still work without push events.
                    return
                }
                nextSessionKey = currentSessionKey
                continue
            }
            let currentSessionKey = self.sessionKey
            guard currentSessionKey != nextSessionKey else { return }
            nextSessionKey = currentSessionKey
        }
    }

    private func refreshRunStateAfterForeground() async {
        let context = self.beginHistoryRequest()
        self.logDiagnostic(
            "chat.ui foreground refresh sessionKey=\(context.session.key) "
                + "pending=\(self.pendingRunCount)")
        let refresh = await self.refreshHistoryAfterRun(historyRequest: context)
        guard self.isCurrentSession(context.session) else { return }
        if refresh.applied,
           refresh.runSnapshotApplied,
           context.runOwnershipGeneration == self.runOwnershipGeneration,
           !self.isSending,
           refresh.supportsInFlightRunState,
           !refresh.hasInFlightRun
        {
            self.clearPendingRuns(
                reason: nil,
                hapticEvent: self.assistantHapticEventAfterLatestUser())
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
        }
        await self.pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
    }

    private static let resetTriggers: Set<String> = ["/reset", "/clear"]
    private static let compactTriggers: Set<String> = ["/compact"]

    private func loadSlashCommands(force: Bool) async {
        guard self.transport.supportsSlashCommandCatalog else { return }
        guard force || !self.hasLoadedSlashCommands else { return }
        guard !self.isLoadingSlashCommands else { return }
        let sessionSnapshot = self.currentSessionSnapshot()
        self.isLoadingSlashCommands = true
        defer { self.isLoadingSlashCommands = false }

        do {
            let commands = try await self.transport.listCommands(sessionKey: sessionSnapshot.key)
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.slashCommands = commands
            self.slashFilterCache = nil
            self.slashCommandsErrorText = nil
            self.hasLoadedSlashCommands = true
        } catch {
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.slashCommandsErrorText = error.localizedDescription
        }
    }

    private func waitForSlashCommandLoadIfNeeded() async {
        guard self.transport.supportsSlashCommandCatalog else { return }
        if !self.hasLoadedSlashCommands, !self.isLoadingSlashCommands {
            await self.loadSlashCommands(force: false)
            return
        }
        while self.isLoadingSlashCommands {
            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return
            }
        }
    }

    private func validateSlashCommandDraftForSend(trimmed: String) async -> Bool {
        guard let slashName = Self.slashCommandName(from: trimmed) else {
            return true
        }
        guard !slashName.isEmpty else {
            self.errorText = "Choose a command."
            return false
        }

        await self.waitForSlashCommandLoadIfNeeded()

        if self.hasLoadedSlashCommands,
           Self.isKnownSlashCommandText(trimmed, commands: self.slashCommands),
           !self.attachments.isEmpty
        {
            self.errorText = "Commands cannot be sent with attachments."
            return false
        }
        return true
    }

    private func resetSlashCommandCatalog() {
        self.slashCommands = []
        self.slashFilterCache = nil
        self.slashCommandsErrorText = nil
        self.hasLoadedSlashCommands = false
    }

    private static func slashCommandName(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.hasPrefix("//") else { return nil }
        let body = trimmed.dropFirst()
        guard let rawName = body.split(whereSeparator: { $0.isWhitespace }).first else {
            return ""
        }
        let name = rawName.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: true).first ?? ""
        return String(name).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isKnownSlashCommandText(
        _ text: String,
        commands: [OpenClawChatCommandChoice]) -> Bool
    {
        guard let commandName = self.slashCommandName(from: text), !commandName.isEmpty else {
            return false
        }
        if self.commands(commands, containInvocationName: commandName) {
            return true
        }
        guard commandName == "skill" else { return false }
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 2 else {
            return self.commands(commands, containInvocationName: commandName)
        }
        let skillName = String(parts[1]).lowercased()
        return commands.contains { command in
            command.source == .skill && self.command(command, matchesInvocationName: skillName)
        }
    }

    private static func commands(
        _ commands: [OpenClawChatCommandChoice],
        containInvocationName name: String) -> Bool
    {
        commands.contains { self.command($0, matchesInvocationName: name) }
    }

    private static func command(
        _ command: OpenClawChatCommandChoice,
        matchesInvocationName name: String) -> Bool
    {
        let normalizedName = name.lowercased()
        if command.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalizedName {
            return true
        }
        return command.textAliases.contains { alias in
            self.slashCommandName(from: alias) == normalizedName
        }
    }

    private static func filteredSlashCommands(
        _ commands: [OpenClawChatCommandChoice],
        query rawQuery: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = self.normalizedSlashQuery(trimmed)
        let effectiveFilter: OpenClawChatCommandFilter =
            self.queryTargetsSkills(trimmed) && filter == .all ? .skills : filter
        return commands.enumerated()
            .compactMap { index, command -> (Int, Int, OpenClawChatCommandChoice)? in
                guard self.command(command, isIncludedIn: effectiveFilter) else { return nil }
                guard let rank = self.commandSearchRank(command, query: query) else { return nil }
                return (rank, index, command)
            }
            .sorted {
                if $0.0 != $1.0 { return $0.0 < $1.0 }
                return $0.1 < $1.1
            }
            .map(\.2)
    }

    private static func normalizedSlashQuery(_ query: String) -> String {
        let withoutSlash = query.hasPrefix("/") ? String(query.dropFirst()) : query
        let lower = withoutSlash.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower == "skill" {
            return ""
        }
        if lower.hasPrefix("skill ") {
            return String(lower.dropFirst("skill ".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return lower
    }

    private static func queryTargetsSkills(_ query: String) -> Bool {
        let withoutSlash = query.hasPrefix("/") ? String(query.dropFirst()) : query
        let lower = withoutSlash.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower == "skill" || lower.hasPrefix("skill ")
    }

    private static func command(
        _ command: OpenClawChatCommandChoice,
        isIncludedIn filter: OpenClawChatCommandFilter) -> Bool
    {
        switch filter {
        case .all:
            true
        case .commands:
            command.source != .skill
        case .skills:
            command.source == .skill
        }
    }

    private static func commandSearchRank(
        _ command: OpenClawChatCommandChoice,
        query: String) -> Int?
    {
        guard !query.isEmpty else { return 0 }
        let names = ([command.name, command.preferredInvocation] + command.textAliases)
            .map { candidate in
                let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
                let withoutSlash = trimmed.hasPrefix("/") ? String(trimmed.dropFirst()) : trimmed
                return withoutSlash.lowercased()
            }
            .filter { !$0.isEmpty }
        if names.contains(where: { $0.hasPrefix(query) }) {
            return 0
        }
        if names.contains(where: { $0.contains(query) }) {
            return 1
        }
        if command.description.lowercased().contains(query) {
            return 2
        }
        if command.source.rawValue.lowercased().contains(query) {
            return 3
        }
        return nil
    }

    private func handleLocalSlashCommandIfNeeded(_ command: String) async -> Bool {
        if command == "/new" {
            self.input = ""
            await self.startNewSession()
            return true
        }
        if Self.resetTriggers.contains(command) {
            self.input = ""
            await self.performReset()
            return true
        }
        if Self.compactTriggers.contains(command) {
            self.input = ""
            await self.performCompact()
            return true
        }
        return false
    }

    private func performSend() async {
        guard !self.isSending else {
            self.logDiagnostic("chat.ui send ignored reason=sending sessionKey=\(self.sessionKey)")
            return
        }
        guard self.pendingRuns.isEmpty else {
            self.logDiagnostic(
                "chat.ui send ignored reason=pending sessionKey=\(self.sessionKey) "
                    + "pending=\(self.pendingRunCount)")
            return
        }
        let trimmed = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !self.attachments.isEmpty else {
            self.logDiagnostic("chat.ui send ignored reason=empty sessionKey=\(self.sessionKey)")
            return
        }

        let command = trimmed.lowercased()
        if await self.handleLocalSlashCommandIfNeeded(command) {
            return
        }
        guard await self.validateSlashCommandDraftForSend(trimmed: trimmed) else {
            return
        }

        let sessionSnapshot = self.currentSessionSnapshot()
        let sessionKey = sessionSnapshot.key

        // Raised before the health poll so the entry guard covers the whole
        // async path: a second submit during `pollHealthIfNeeded` would
        // otherwise re-capture the same draft and enqueue a duplicate
        // outbox row.
        self.isSending = true
        defer { self.isSending = false }

        if !self.healthOK {
            await self.pollHealthIfNeeded(force: true, sessionSnapshot: sessionSnapshot)
            guard self.isCurrentSession(sessionSnapshot) else { return }
            // Offline capture: queue text-only sends durably instead of
            // failing. Attachments stay on the live path (text only in v1).
            if !self.healthOK, self.outbox != nil, self.attachments.isEmpty {
                self.logDiagnostic(
                    "chat.ui send queued offline sessionKey=\(sessionKey) inputLen=\(trimmed.count)")
                await self.enqueueOutboxCommand(text: trimmed, session: sessionSnapshot)
                return
            }
        }

        // FIFO across the reconnect boundary: while this session still has
        // queued/sending outbox rows — or restore has not yet adopted rows
        // persisted by an earlier process, so we must assume a backlog — a
        // live send would race ahead of them. Route it through the outbox so
        // the queue stays the single ordering authority; it flushes
        // immediately while healthy, so the turn still sends right away.
        // Failed rows are parked user decisions and do not hold new sends
        // hostage. Attachment sends stay live (online-only in v1) and are
        // documented as outside the ordering guarantee. Deliberately
        // session-scoped: other sessions' queued rows are separate
        // conversations with no ordering contract against this send.
        if self.outbox != nil, self.attachments.isEmpty,
           !self.hasRestoredOutboxMessages
           || self.outboxStatesByMessageID.values.contains(where: { !$0.isFailed })
        {
            self.logDiagnostic(
                "chat.ui send routed behind outbox sessionKey=\(sessionKey) inputLen=\(trimmed.count)")
            await self.enqueueOutboxCommand(text: trimmed, session: sessionSnapshot)
            return
        }

        self.errorText = nil
        let runId = UUID().uuidString
        let messageText = trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : trimmed
        let thinkingLevel = self.thinkingLevel
        self.pendingRuns.insert(runId)
        self.armPendingRunTimeout(runId: runId)
        self.logDiagnostic(
            "chat.ui send queued sessionKey=\(sessionKey) "
                + "localRunId=\(runId) pending=\(self.pendingRunCount)")
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)

        // Optimistically append user message to UI.
        var userContent: [OpenClawChatMessageContent] = [
            OpenClawChatMessageContent(
                type: "text",
                text: messageText,
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil),
        ]
        let encodedAttachments = self.attachments.map { att -> OpenClawChatAttachmentPayload in
            OpenClawChatAttachmentPayload(
                type: att.type,
                mimeType: att.mimeType,
                fileName: att.fileName,
                content: att.data.base64EncodedString())
        }
        for att in encodedAttachments {
            userContent.append(
                OpenClawChatMessageContent(
                    type: att.type,
                    text: nil,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                    content: AnyCodable(att.content),
                    id: nil,
                    name: nil,
                    arguments: nil))
        }
        let userMessageTimestamp = Date().timeIntervalSince1970 * 1000
        let userMessageID = UUID()
        self.appendMessage(
            OpenClawChatMessage(
                id: userMessageID,
                role: "user",
                content: userContent,
                timestamp: userMessageTimestamp,
                idempotencyKey: "\(runId):user"))
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = userMessageID
        self.runMessageScopesByRunID[runId] = self.currentRunMessageScope()

        // Clear input immediately for responsive UX (before network await)
        self.input = ""
        self.attachments = []

        do {
            await self.waitForPendingModelPatches(in: sessionKey)
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.logDiagnostic(
                "chat.ui transport send start sessionKey=\(sessionKey) "
                    + "localRunId=\(runId)")
            let response = try await transport.sendMessage(
                sessionKey: sessionKey,
                message: messageText,
                thinking: thinkingLevel,
                idempotencyKey: runId,
                attachments: encodedAttachments)
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.logDiagnostic(
                "chat.ui transport send accepted sessionKey=\(sessionKey) "
                    + "localRunId=\(runId) remoteRunId=\(response.runId)")
            if response.status != "error", response.status != "timeout" {
                self.haptics.perform(.messageSent)
            }
            var reusedRunAlreadyFinal = false
            if response.runId != runId {
                let pendingUserMessageID = self.pendingLocalUserEchoMessageIDsByRunID.removeValue(forKey: runId)
                let localRunScope = self.runMessageScopesByRunID.removeValue(forKey: runId)
                self.clearPendingRun(runId)
                self.pendingRuns.insert(response.runId)
                // The gateway can reuse an identical active run without writing
                // this second turn. Move the optimistic row onto that durable
                // identity, collapsing it if the canonical row is already here.
                let rekeyedUserEcho = self.rekeyLocalUserEcho(
                    messageID: pendingUserMessageID,
                    runId: response.runId)
                self.pendingLocalUserEchoMessageIDsByRunID[response.runId] = rekeyedUserEcho?.pendingMessageID
                let remoteRunScope = rekeyedUserEcho?.scope ?? localRunScope ?? self.currentRunMessageScope()
                self.runMessageScopesByRunID[response.runId] = remoteRunScope
                self.rescopeProvisionalFinalMessages(runId: response.runId, scope: remoteRunScope)
                reusedRunAlreadyFinal = self.hasRecordedFinalMessage(runId: response.runId)
                if reusedRunAlreadyFinal {
                    self.clearPendingRun(response.runId, hapticEvent: .runCompleted)
                    self.pendingToolCallsById = [:]
                    self.updateStreamingAssistantText(nil)
                } else {
                    self.armPendingRunTimeout(runId: response.runId)
                }
            }
            if response.status == "ok" {
                let historyContext = self.beginHistoryRequest(for: sessionSnapshot)
                await self.refreshHistoryAfterRun(historyRequest: historyContext)
                guard self.isCurrentSession(sessionSnapshot) else { return }
                self.finishPendingRunAfterTerminalOkSendAck(response)
            } else if !self.finishPendingRunIfTerminalSendAck(response),
                      !reusedRunAlreadyFinal
            {
                let historyContext = self.beginHistoryRequest(for: sessionSnapshot)
                let refresh = await self.refreshHistoryAfterRun(historyRequest: historyContext)
                guard self.isCurrentSession(sessionSnapshot) else { return }
                let hasInFlightRunSnapshot = refresh.applied &&
                    refresh.runSnapshotApplied &&
                    refresh.hasInFlightRun
                if hasInFlightRunSnapshot ||
                    !self.clearPendingRunIfAssistantMessagePresent(
                        runId: response.runId,
                        after: userMessageTimestamp)
                {
                    self.armPostSendRefreshFallback(
                        runId: response.runId,
                        sessionSnapshot: sessionSnapshot,
                        userMessageTimestamp: userMessageTimestamp)
                    self.armRunCompletionRefresh(
                        runId: response.runId,
                        sessionSnapshot: sessionSnapshot,
                        userMessageTimestamp: userMessageTimestamp)
                }
            }
        } catch {
            guard self.isCurrentSession(sessionSnapshot) else { return }
            // Stale-healthy disconnects surface here instead of at the send
            // gate. Requeue text-only sends durably (same runId = same
            // idempotency identity, safe even if the send actually landed)
            // and keep the optimistic bubble as the queued row.
            if encodedAttachments.isEmpty {
                self.runMessageScopesByRunID.removeValue(forKey: runId)
                self.clearPendingRun(runId)
                let requeued = await self.requeueFailedLiveSend(
                    runId: runId,
                    text: messageText,
                    thinking: thinkingLevel,
                    messageID: userMessageID,
                    session: sessionSnapshot)
                if requeued {
                    self.logDiagnostic(
                        "chat.ui send requeued offline sessionKey=\(sessionKey) "
                            + "localRunId=\(runId) error=\(error.localizedDescription)")
                    return
                }
                guard self.isCurrentSession(sessionSnapshot) else { return }
                // Refused requeue (queue full / broken store): restore the
                // draft so the text is not lost with the failed bubble.
                if self.input.isEmpty {
                    self.input = messageText
                }
            }
            self.removePendingLocalUserEcho(for: runId)
            self.runMessageScopesByRunID.removeValue(forKey: runId)
            self.errorText = error.localizedDescription
            self.clearPendingRun(runId, hapticEvent: .runFailed)
            self.logDiagnostic(
                "chat.ui send failed sessionKey=\(sessionKey) "
                    + "localRunId=\(runId) error=\(error.localizedDescription)")
            chatUILogger.error("chat transport send failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func performAbort() async {
        guard !self.pendingRuns.isEmpty else { return }
        guard !self.isAborting else { return }
        self.isAborting = true
        defer { self.isAborting = false }

        let runIds = Array(pendingRuns)
        for runId in runIds {
            do {
                try await self.transport.abortRun(sessionKey: self.sessionKey, runId: runId)
            } catch {
                // Best-effort.
            }
        }
    }

    private func fetchSessions(limit: Int?, sessionSnapshot: SessionSnapshot? = nil) async {
        do {
            let res = try await transport.listSessions(limit: limit)
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.sessions = res.sessions
            self.sessionDefaults = res.defaults
            self.hasAppliedLiveSessions = true
            self.syncSelectedModel()
            self.syncThinkingLevelOptions()
            self.persistSessionsToCache(res.sessions)
        } catch {
            // Best-effort.
        }
    }

    private func fetchModels(sessionSnapshot: SessionSnapshot? = nil) async {
        do {
            let modelChoices = try await transport.listModels()
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.modelChoices = modelChoices
            self.syncSelectedModel()
        } catch {
            // Best-effort.
        }
    }

    private func applySessionSwitch(to sessionKey: String, intent: SessionSwitchIntent) {
        let next = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else { return }
        guard next != self.sessionKey else { return }
        self.advanceSessionGeneration()
        self.sessionKey = next
        if intent == .userInitiated {
            self.onSessionChanged?(next)
        }
        self.clearSessionOwnedState()
        self.startBootstrap(sessionKey: next)
    }

    private func performStartNewSession(worktree: Bool) async {
        let requested = self.generatedNewSessionKey()
        let parentSessionKey = self.sessionKey
        let next: String
        do {
            let created = try await transport.createSession(
                key: requested,
                label: nil,
                parentSessionKey: parentSessionKey,
                worktree: worktree ? true : nil)
            let createdKey = created.key.trimmingCharacters(in: .whitespacesAndNewlines)
            next = createdKey.isEmpty ? requested : createdKey
        } catch {
            if Self.isUnsupportedCreateSessionError(error) {
                chatUILogger.info("sessions.create unsupported; falling back to sessions.reset")
                await self.performReset()
                return
            }
            chatUILogger.error("sessions.create failed \(error.localizedDescription, privacy: .public)")
            self.errorText = error.localizedDescription
            return
        }
        self.advanceSessionGeneration()
        self.sessionKey = next
        self.onSessionChanged?(next)
        self.clearSessionOwnedState()
        self.errorText = nil
        self.startBootstrap()
    }

    /// Clears state owned by the current session/agent before a new identity can consume events.
    private func clearSessionOwnedState() {
        self.modelSelectionID = Self.defaultModelSelectionID
        self.replaceMessages([])
        self.isShowingCachedTranscript = false
        self.hasAppliedLiveHistory = false
        self.pendingLocalUserEchoMessageIDsByRunID.removeAll()
        self.runMessageScopesByRunID.removeAll()
        self.provisionalFinalMessagesByID.removeAll()
        self.recentlySentOutboxUserKeys.removeAll()
        self.resetOutboxPresentationForSessionSwitch()
        self.sessionId = nil
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.resetSlashCommandCatalog()
        self.clearPendingRuns(reason: nil)
    }

    private static func isUnsupportedCreateSessionError(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == "OpenClawChatTransport"
            && nsError.localizedDescription == "sessions.create not supported by this transport"
    }

    private func performReset() async {
        self.isLoading = true
        self.errorText = nil

        do {
            try await self.transport.resetSession(sessionKey: self.sessionKey)
        } catch {
            self.isLoading = false
            self.errorText = error.localizedDescription
            chatUILogger.error("session reset failed \(error.localizedDescription, privacy: .public)")
            return
        }

        self.runMessageScopesByRunID.removeAll()
        self.provisionalFinalMessagesByID.removeAll()
        self.startBootstrap()
    }

    private func performCompact() async {
        guard !self.isCompacting else { return }
        guard !self.isSending, self.pendingRuns.isEmpty, !self.isAborting else {
            self.errorText = "Wait for the current response before compacting the session."
            return
        }
        if let lastCompactAt,
           Date().timeIntervalSince(lastCompactAt) < compactCooldown
        {
            self.errorText = "Please wait before compacting this session again."
            return
        }

        self.isCompacting = true
        self.isLoading = true
        self.errorText = nil
        defer {
            self.isCompacting = false
        }

        do {
            try await self.transport.compactSession(sessionKey: self.sessionKey)
        } catch {
            self.isLoading = false
            self.errorText = "Unable to compact the session. Please try again."
            let nsError = error as NSError
            chatUILogger.error(
                "compact failed domain=\(nsError.domain, privacy: .public) code=\(nsError.code, privacy: .public)")
            chatUILogger.error("compact details=\(String(describing: error), privacy: .private)")
            return
        }

        lastCompactAt = Date()
        self.startBootstrap()
    }

    private func performSelectThinkingLevel(_ level: String) async {
        let next = Self.normalizedThinkingLevel(level) ?? "off"
        guard next != self.thinkingLevel else { return }

        let sessionKey = self.sessionKey
        self.thinkingLevel = next
        self.syncThinkingLevelOptions()
        self.updateCurrentSessionThinkingLevel(next, sessionKey: sessionKey)
        self.onThinkingLevelChanged?(next)
        self.nextThinkingSelectionRequestID &+= 1
        let requestID = self.nextThinkingSelectionRequestID
        self.latestThinkingSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestThinkingLevelsBySession[sessionKey] = next

        do {
            try await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: next)
            guard requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey] else {
                let latest = self.latestThinkingLevelsBySession[sessionKey] ?? next
                guard latest != next else { return }
                try? await self.transport.setSessionThinking(sessionKey: sessionKey, thinkingLevel: latest)
                return
            }
        } catch {
            guard sessionKey == self.sessionKey,
                  requestID == self.latestThinkingSelectionRequestIDsBySession[sessionKey]
            else { return }
            // Best-effort. Persisting the user's local preference matters more than a patch error here.
        }
    }

    private func performSelectModel(_ selectionID: String) async {
        let next = self.normalizedSelectionID(selectionID)
        guard next != self.modelSelectionID else { return }

        let sessionKey = self.sessionKey
        let previous = self.modelSelectionID
        let previousRequestID = self.latestModelSelectionRequestIDsBySession[sessionKey]
        self.nextModelSelectionRequestID &+= 1
        let requestID = self.nextModelSelectionRequestID
        let nextModelRef = self.modelRef(forSelectionID: next)
        self.latestModelSelectionRequestIDsBySession[sessionKey] = requestID
        self.latestModelSelectionIDsBySession[sessionKey] = next
        self.beginModelPatch(for: sessionKey)
        self.modelSelectionID = next
        self.errorText = nil
        defer { self.endModelPatch(for: sessionKey) }

        do {
            try await self.transport.setSessionModel(
                sessionKey: sessionKey,
                model: nextModelRef)
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else {
                // Keep older successful patches as rollback state, but do not replay
                // stale UI/session state over a newer in-flight or completed selection.
                self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = next
                return
            }
            self.applySuccessfulModelSelection(next, sessionKey: sessionKey, syncSelection: true)
        } catch {
            guard requestID == self.latestModelSelectionRequestIDsBySession[sessionKey] else { return }
            self.latestModelSelectionIDsBySession[sessionKey] = previous
            if let previousRequestID {
                self.latestModelSelectionRequestIDsBySession[sessionKey] = previousRequestID
            } else {
                self.latestModelSelectionRequestIDsBySession.removeValue(forKey: sessionKey)
            }
            if self.lastSuccessfulModelSelectionIDsBySession[sessionKey] == previous {
                self.applySuccessfulModelSelection(
                    previous,
                    sessionKey: sessionKey,
                    syncSelection: sessionKey == self.sessionKey)
            }
            guard sessionKey == self.sessionKey else { return }
            self.modelSelectionID = previous
            self.errorText = error.localizedDescription
            chatUILogger.error("sessions.patch(model) failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func beginModelPatch(for sessionKey: String) {
        self.inFlightModelPatchCountsBySession[sessionKey, default: 0] += 1
    }

    private func endModelPatch(for sessionKey: String) {
        let remaining = max(0, (inFlightModelPatchCountsBySession[sessionKey] ?? 0) - 1)
        if remaining == 0 {
            self.inFlightModelPatchCountsBySession.removeValue(forKey: sessionKey)
            let waiters = self.modelPatchWaitersBySession.removeValue(forKey: sessionKey) ?? []
            for waiter in waiters {
                waiter.resume()
            }
            return
        }
        self.inFlightModelPatchCountsBySession[sessionKey] = remaining
    }

    /// Internal for the outbox flush, which must honor the same ordering
    /// behind in-flight model patches as the live send path.
    func waitForPendingModelPatches(in sessionKey: String) async {
        guard (self.inFlightModelPatchCountsBySession[sessionKey] ?? 0) > 0 else { return }
        await withCheckedContinuation { continuation in
            self.modelPatchWaitersBySession[sessionKey, default: []].append(continuation)
        }
    }

    func placeholderSession(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }

    private func syncSelectedModel() {
        let currentSession = self.sessions.first(where: { $0.key == self.sessionKey })
        let explicitModelID = self.normalizedModelSelectionID(
            currentSession?.model,
            provider: currentSession?.modelProvider)
        if let explicitModelID {
            self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = explicitModelID
            self.modelSelectionID = explicitModelID
            return
        }
        self.lastSuccessfulModelSelectionIDsBySession[self.sessionKey] = Self.defaultModelSelectionID
        self.modelSelectionID = Self.defaultModelSelectionID
    }

    private func normalizedSelectionID(_ selectionID: String) -> String {
        let trimmed = selectionID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Self.defaultModelSelectionID }
        return trimmed
    }

    private func normalizedModelSelectionID(_ modelID: String?, provider: String? = nil) -> String? {
        guard let modelID else { return nil }
        let trimmed = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let provider = Self.normalizedProvider(provider) {
            let providerQualified = Self.providerQualifiedModelSelectionID(modelID: trimmed, provider: provider)
            if let match = modelChoices.first(where: {
                $0.selectionID == providerQualified ||
                    ($0.modelID == trimmed && Self.normalizedProvider($0.provider) == provider)
            }) {
                return match.selectionID
            }
            return providerQualified
        }
        if self.modelChoices.contains(where: { $0.selectionID == trimmed }) {
            return trimmed
        }
        let matches = self.modelChoices.filter { $0.modelID == trimmed || $0.selectionID == trimmed }
        if matches.count == 1 {
            return matches[0].selectionID
        }
        return trimmed
    }

    private func modelRef(forSelectionID selectionID: String) -> String? {
        let normalized = self.normalizedSelectionID(selectionID)
        if normalized == Self.defaultModelSelectionID {
            return nil
        }
        return normalized
    }

    private func generatedNewSessionKey() -> String {
        let baseKey = "ios-\(UUID().uuidString.lowercased())"
        guard let agentID = Self.agentID(fromSessionKey: sessionKey) ??
            self.activeAgentId ??
            Self.agentID(fromSessionKey: resolvedMainSessionKey) ??
            sessions.lazy.compactMap({ Self.agentID(fromSessionKey: $0.key) }).first
        else {
            return baseKey
        }
        return "agent:\(agentID):\(baseKey)"
    }

    private static func agentID(fromSessionKey sessionKey: String) -> String? {
        let parts = sessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    private func modelLabel(for modelID: String) -> String {
        self.modelChoices.first(where: { $0.selectionID == modelID || $0.modelID == modelID })?.displayLabel ??
            modelID
    }

    private func applySuccessfulModelSelection(_ selectionID: String, sessionKey: String, syncSelection: Bool) {
        self.lastSuccessfulModelSelectionIDsBySession[sessionKey] = selectionID
        let resolved = self.resolvedSessionModelIdentity(forSelectionID: selectionID)
        self.updateCurrentSessionModel(
            modelID: resolved.modelID,
            modelProvider: resolved.modelProvider,
            sessionKey: sessionKey,
            syncSelection: syncSelection)
        if sessionKey == self.sessionKey {
            self.syncThinkingLevelOptions()
        }
    }

    private func resolvedSessionModelIdentity(forSelectionID selectionID: String)
        -> (modelID: String?, modelProvider: String?)
    {
        guard let modelRef = modelRef(forSelectionID: selectionID) else {
            return (nil, nil)
        }
        if let choice = modelChoices.first(where: { $0.selectionID == modelRef }) {
            return (choice.modelID, Self.normalizedProvider(choice.provider))
        }
        return (modelRef, nil)
    }

    private static func normalizedProvider(_ provider: String?) -> String? {
        let trimmed = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }

    private static func providerQualifiedModelSelectionID(modelID: String, provider: String) -> String {
        let providerPrefix = "\(provider)/"
        if modelID.hasPrefix(providerPrefix) {
            return modelID
        }
        return "\(provider)/\(modelID)"
    }

    private func updateCurrentSessionThinkingLevel(_ thinkingLevel: String?, sessionKey: String) {
        guard let index = sessions.firstIndex(where: { $0.key == sessionKey }) else { return }
        let current = self.sessions[index]
        self.sessions[index] = OpenClawChatSessionEntry(
            key: current.key,
            kind: current.kind,
            displayName: current.displayName,
            surface: current.surface,
            subject: current.subject,
            room: current.room,
            space: current.space,
            updatedAt: current.updatedAt,
            sessionId: current.sessionId,
            systemSent: current.systemSent,
            abortedLastRun: current.abortedLastRun,
            thinkingLevel: thinkingLevel,
            verboseLevel: current.verboseLevel,
            inputTokens: current.inputTokens,
            outputTokens: current.outputTokens,
            totalTokens: current.totalTokens,
            modelProvider: current.modelProvider,
            model: current.model,
            contextTokens: current.contextTokens,
            thinkingLevels: current.thinkingLevels,
            thinkingOptions: current.thinkingOptions,
            thinkingDefault: current.thinkingDefault)
    }

    private func updateCurrentSessionModel(
        modelID: String?,
        modelProvider: String?,
        sessionKey: String,
        syncSelection: Bool)
    {
        if let index = sessions.firstIndex(where: { $0.key == sessionKey }) {
            let current = self.sessions[index]
            self.sessions[index] = OpenClawChatSessionEntry(
                key: current.key,
                kind: current.kind,
                displayName: current.displayName,
                surface: current.surface,
                subject: current.subject,
                room: current.room,
                space: current.space,
                updatedAt: current.updatedAt,
                sessionId: current.sessionId,
                systemSent: current.systemSent,
                abortedLastRun: current.abortedLastRun,
                thinkingLevel: current.thinkingLevel,
                verboseLevel: current.verboseLevel,
                inputTokens: current.inputTokens,
                outputTokens: current.outputTokens,
                totalTokens: current.totalTokens,
                modelProvider: modelProvider,
                model: modelID,
                contextTokens: current.contextTokens)
        } else {
            let placeholder = self.placeholderSession(key: sessionKey)
            self.sessions.append(
                OpenClawChatSessionEntry(
                    key: placeholder.key,
                    kind: placeholder.kind,
                    displayName: placeholder.displayName,
                    surface: placeholder.surface,
                    subject: placeholder.subject,
                    room: placeholder.room,
                    space: placeholder.space,
                    updatedAt: placeholder.updatedAt,
                    sessionId: placeholder.sessionId,
                    systemSent: placeholder.systemSent,
                    abortedLastRun: placeholder.abortedLastRun,
                    thinkingLevel: placeholder.thinkingLevel,
                    verboseLevel: placeholder.verboseLevel,
                    inputTokens: placeholder.inputTokens,
                    outputTokens: placeholder.outputTokens,
                    totalTokens: placeholder.totalTokens,
                    modelProvider: modelProvider,
                    model: modelID,
                    contextTokens: placeholder.contextTokens))
        }
        if syncSelection {
            self.syncSelectedModel()
        }
    }

    private func handleTransportEvent(_ evt: OpenClawChatTransportEvent) {
        switch evt {
        case let .health(ok):
            self.applyTransportHealth(ok)
        case .tick:
            let context = self.currentSessionSnapshot()
            Task { await self.pollHealthIfNeeded(force: false, sessionSnapshot: context) }
        case let .chat(chat):
            self.handleChatEvent(chat)
        case let .sessionMessage(message):
            self.handleSessionMessageEvent(message)
        case let .agent(agent):
            self.handleAgentEvent(agent)
        case .seqGap:
            self.errorText = nil
            self.invalidateHistorySnapshots()
            self.invalidateRunSnapshots()
            self.clearPendingRuns(reason: nil)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            let context = self.beginHistoryRequest()
            Task {
                await self.refreshHistoryAfterRun(historyRequest: context)
                await self.pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
            }
        }
    }

    private func handleSessionMessageEvent(_ payload: OpenClawSessionMessageEventPayload) {
        if let sessionKey = payload.sessionKey,
           !self.matchesCurrentSessionKey(incoming: sessionKey, agentId: payload.agentId, current: self.sessionKey)
        {
            return
        }

        guard let message = payload.message else { return }

        let sanitized = Self.stripInboundMetadata(from: message)
        self.invalidateHistorySnapshots()
        // The active client also receives the gateway's echo of the user turn it
        // just sent. performSend already appended an optimistic row carrying a
        // local client timestamp, while the echo carries a server timestamp, so
        // the timestamp-keyed identity/dedupe paths below never collapse them.
        // Adopt the server record onto the exactly correlated row even when the
        // run's final event already cleared pending state. Same-content turns
        // without this key remain distinct.
        if self.adoptCorrelatedUserMessage(incoming: sanitized) {
            return
        }
        if self.adoptProvisionalFinalMessage(incoming: sanitized) {
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [sanitized])
        self.replaceMessages(Self.dedupeMessages(reconciled))
        self.pruneProvisionalFinalMessages()
        self.pruneRunMessageScopes()
    }

    private func handleChatEvent(_ chat: OpenClawChatEventPayload) {
        let isOurRun = chat.runId.flatMap { self.pendingRuns.contains($0) } ?? false
        if let runId = chat.runId {
            self.logDiagnostic(
                "chat.ui event chat state=\(chat.state ?? "unknown") "
                    + "runId=\(runId) ours=\(isOurRun) pending=\(self.pendingRunCount)")
        }

        // Gateway may publish canonical session keys (for example "agent:main:main")
        // even when this view currently uses an alias key (for example "main").
        // Never drop events for our own pending run on key mismatch, or the UI can stay
        // stuck at "thinking" until the user reopens and forces a history reload.
        if let sessionKey = chat.sessionKey,
           !self.matchesCurrentSessionKey(
               incoming: sessionKey,
               agentId: chat.agentId,
               current: self.sessionKey),
           !isOurRun
        {
            return
        }
        if chat.state == "delta",
           let runId = Self.normalizedRunID(chat.runId)
        {
            guard self.pendingRuns.isEmpty || self.pendingRuns.contains(runId) else {
                return
            }
            self.invalidateRunSnapshots()
            self.adoptRun(
                runId: runId,
                bufferedText: OpenClawChatEventText.assistantText(from: chat) ?? "")
            return
        }
        if chat.state == "final" || chat.state == "aborted" || chat.state == "error" {
            self.invalidateHistorySnapshots()
        }
        self.invalidateRunSnapshots()
        if !isOurRun {
            // Keep multiple clients in sync: if another client finishes a run for our session, refresh history.
            switch chat.state {
            case "final", "aborted", "error":
                self.updateStreamingAssistantText(nil)
                self.pendingToolCallsById = [:]
                self.appendFinalChatMessageIfPresent(chat)
                let context = self.beginHistoryRequest()
                Task { await self.refreshHistoryAfterRun(historyRequest: context) }
            default:
                break
            }
            return
        }

        switch chat.state {
        case "final", "aborted", "error":
            if chat.state == "error" {
                self.errorText = chat.errorMessage ?? "Chat failed"
            }
            let hapticEvent: OpenClawChatHaptics.Event? = switch chat.state {
            case "final": .runCompleted
            case "error": .runFailed
            default: nil
            }
            if let runId = chat.runId {
                self.clearPendingRun(runId, hapticEvent: hapticEvent)
            } else if self.pendingRuns.count <= 1 {
                self.clearPendingRuns(reason: nil, hapticEvent: hapticEvent)
            }
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.appendFinalChatMessageIfPresent(chat)
            let context = self.beginHistoryRequest()
            Task { await self.refreshHistoryAfterRun(historyRequest: context) }
        default:
            break
        }
    }

    private func appendFinalChatMessageIfPresent(_ chat: OpenClawChatEventPayload) {
        guard chat.state == "final" else { return }
        guard let text = OpenClawChatEventText.assistantText(from: chat) else { return }

        let decoded = chat.message.flatMap {
            try? ChatPayloadDecoding.decode($0, as: OpenClawChatMessage.self)
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
                        text: text,
                        thinking: nil,
                        thinkingSignature: nil,
                        mimeType: nil,
                        fileName: nil,
                        content: nil,
                        id: nil,
                        name: nil,
                        arguments: nil),
                ],
                timestamp: Date().timeIntervalSince1970 * 1000,
                stopReason: "stop")
        }

        let runId = Self.normalizedRunID(chat.runId)
        let scope = self.runMessageScope(for: runId)
        guard self.isCurrentSession(scope.session) else { return }
        guard let reconciliationKey = Self.finalMessageReconciliationKey(for: message) else { return }
        if let runId, self.hasRecordedFinalMessage(runId: runId) {
            return
        }

        if self.hasCanonicalFinalMessageMatching(message, scope: scope) {
            if let runId {
                self.runMessageScopesByRunID.removeValue(forKey: runId)
            }
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [message])
        self.replaceMessages(Self.dedupeMessages(reconciled))
        if self.messages.contains(where: { $0.id == message.id }) {
            self.provisionalFinalMessagesByID[message.id] = ProvisionalFinalMessage(
                reconciliationKey: reconciliationKey,
                runId: runId,
                scope: scope)
        }
        self.pruneProvisionalFinalMessages()
        self.pruneRunMessageScopes()
    }

    static func isAssistantMessage(_ message: OpenClawChatMessage) -> Bool {
        message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
    }

    private static func messageWithTimestampIfNeeded(_ message: OpenClawChatMessage) -> OpenClawChatMessage {
        guard message.timestamp == nil else { return message }
        return OpenClawChatMessage(
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: Date().timeIntervalSince1970 * 1000,
            idempotencyKey: message.idempotencyKey,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage)
    }

    private func handleAgentEvent(_ evt: OpenClawAgentEventPayload) {
        let isPendingRun = self.pendingRuns.contains(evt.runId)
        let isLegacySessionStream = self.pendingRuns.isEmpty && self.sessionId == evt.runId
        if !isPendingRun, !isLegacySessionStream {
            return
        }
        self.invalidateRunSnapshots()
        self.logDiagnostic(
            "chat.ui event agent stream=\(evt.stream) "
                + "runId=\(evt.runId) pending=\(self.pendingRunCount)")

        switch evt.stream {
        case "assistant":
            if let text = evt.data["text"]?.value as? String {
                self.updateStreamingAssistantText(text)
            }
        case "lifecycle":
            self.handleAgentLifecycleEvent(evt, isPendingRun: isPendingRun)
        case "tool":
            guard let phase = evt.data["phase"]?.value as? String else { return }
            guard let name = evt.data["name"]?.value as? String else { return }
            guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
            if phase == "start" {
                let args = evt.data["args"]
                self.pendingToolCallsById[toolCallId] = OpenClawChatPendingToolCall(
                    toolCallId: toolCallId,
                    name: name,
                    args: args,
                    startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                    isError: nil)
            } else if phase == "result" {
                self.pendingToolCallsById[toolCallId] = nil
            }
        default:
            break
        }
    }

    private func handleAgentLifecycleEvent(_ evt: OpenClawAgentEventPayload, isPendingRun: Bool) {
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

        guard isTerminalPhase || isFailure || aborted || isSuccessfulStatus else { return }

        self.invalidateHistorySnapshots()

        if isFailure || aborted {
            self.errorText = Self.agentLifecycleErrorMessage(evt, aborted: aborted)
        }
        if isPendingRun {
            self.clearPendingRun(
                evt.runId,
                hapticEvent: isFailure || aborted ? .runFailed : .runCompleted)
        }
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        let context = self.beginHistoryRequest()
        Task { await self.refreshHistoryAfterRun(historyRequest: context) }
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
        if let message = evt.data["error"]?.value as? String,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return message
        }
        if let message = evt.data["message"]?.value as? String,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return message
        }
        return "Chat failed"
    }

    private func finishPendingRunAfterTerminalOkSendAck(_ response: OpenClawChatSendResponse) {
        self.clearPendingRun(response.runId, hapticEvent: .runCompleted)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.logDiagnostic(
            "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                + "runId=\(response.runId) status=ok")
    }

    private func finishPendingRunIfTerminalSendAck(_ response: OpenClawChatSendResponse) -> Bool {
        switch response.status {
        case "timeout":
            self.removePendingLocalUserEcho(for: response.runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.errorText = "Chat failed before the run started; try again."
            self.clearPendingRun(response.runId, hapticEvent: .runFailed)
            self.logDiagnostic(
                "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                    + "runId=\(response.runId) status=timeout")
            return true
        case "error":
            self.removePendingLocalUserEcho(for: response.runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.errorText = "Chat failed before the run started; try again."
            self.clearPendingRun(response.runId, hapticEvent: .runFailed)
            self.logDiagnostic(
                "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                    + "runId=\(response.runId) status=error")
            return true
        default:
            return false
        }
    }

    private func removePendingLocalUserEcho(for runId: String) {
        guard let messageID = pendingLocalUserEchoMessageIDsByRunID[runId] else { return }
        self.removeMessage(id: messageID)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
    }

    private func armPostSendRefreshFallback(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double)
    {
        Task { [weak self] in
            for delayMs in Self.postSendRefreshDelaysMs {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
                let shouldContinue = await self?.refreshIfPending(
                    runId: runId,
                    sessionSnapshot: sessionSnapshot,
                    after: userMessageTimestamp,
                    diagnostic: "chat.ui refresh fallback sessionKey=\(sessionSnapshot.key) "
                        + "runId=\(runId) delayMs=\(delayMs)")
                guard shouldContinue == true else {
                    return
                }
            }
        }
    }

    private func armRunCompletionRefresh(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double)
    {
        let timeoutMs = Int(pendingRunTimeoutMs)
        let transport = self.transport
        Task { [weak self, transport] in
            let observedCompletion = await transport.waitForRunCompletion(runId: runId, timeoutMs: timeoutMs)
            guard observedCompletion else { return }
            _ = await self?.refreshIfPending(
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                after: userMessageTimestamp,
                diagnostic: "chat.ui run completion refresh sessionKey=\(sessionSnapshot.key) "
                    + "runId=\(runId)")
        }
    }

    private func refreshIfPending(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        after timestamp: Double,
        diagnostic: String) async -> Bool
    {
        guard self.isCurrentSession(sessionSnapshot),
              self.pendingRuns.contains(runId)
        else {
            return false
        }
        self.logDiagnostic(diagnostic)
        let historyContext = self.beginHistoryRequest(for: sessionSnapshot)
        let refresh = await self.refreshHistoryAfterRun(historyRequest: historyContext)
        guard self.isCurrentSession(sessionSnapshot),
              self.pendingRuns.contains(runId)
        else {
            return false
        }
        if refresh.applied, refresh.runSnapshotApplied, refresh.supportsInFlightRunState {
            if refresh.hasInFlightRun {
                return true
            }
            self.clearPendingRun(runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            return false
        }
        return !self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
    }

    @discardableResult
    private func clearPendingRunIfAssistantMessagePresent(runId: String, after timestamp: Double) -> Bool {
        guard let hapticEvent = self.assistantHapticEvent(after: timestamp) else { return false }
        self.clearPendingRun(runId, hapticEvent: hapticEvent)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        return true
    }

    private static func hasUnansweredLatestUser(in messages: [OpenClawChatMessage]) -> Bool {
        self.latestUserTurn(in: messages) != nil && !self.hasAssistantMessageAfterLatestUser(in: messages)
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
        guard let refreshKey = userRefreshIdentityKey(for: messages[userIndex]) else {
            return LatestUserTurn(
                idempotencyKey: self.normalizedIdempotencyKey(messages[userIndex].idempotencyKey),
                refreshKey: nil,
                occurrence: 0,
                timestamp: messages[userIndex].timestamp)
        }
        let occurrence = messages[...userIndex].reduce(into: 0) { count, message in
            guard self.userRefreshIdentityKey(for: message) == refreshKey else { return }
            count += 1
        }
        return LatestUserTurn(
            idempotencyKey: Self.normalizedIdempotencyKey(messages[userIndex].idempotencyKey),
            refreshKey: refreshKey,
            occurrence: occurrence,
            timestamp: messages[userIndex].timestamp)
    }

    private static func hasAnsweredUser(
        _ user: LatestUserTurn,
        in messages: [OpenClawChatMessage])
        -> Bool
    {
        // Hooks may transform persisted user content while preserving this key.
        // Prefer the durable turn identity so a completed refresh rejects older history.
        if let idempotencyKey = user.idempotencyKey {
            guard let userIndex = messages.lastIndex(where: { message in
                message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                    self.normalizedIdempotencyKey(message.idempotencyKey) == idempotencyKey
            }) else {
                return false
            }
            return self.hasAssistantMessage(after: userIndex, in: messages)
        }
        guard let refreshKey = user.refreshKey else { return false }
        var occurrence = 0
        var latestMatchingUserIndex: [OpenClawChatMessage].Index?
        for (index, message) in messages.enumerated() {
            guard self.userRefreshIdentityKey(for: message) == refreshKey else { continue }
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
        guard nextIndex < messages.endIndex else { return false }
        return messages[nextIndex...].contains { message in
            guard message.role.lowercased() == "assistant" else { return false }
            let text = message.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty || message.errorMessage != nil
        }
    }

    private static func hasAssistantMessageAfterLatestUser(in messages: [OpenClawChatMessage]) -> Bool {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else {
            return false
        }
        guard lastUserIndex < messages.index(before: messages.endIndex) else {
            return false
        }
        return messages[messages.index(after: lastUserIndex)...].contains { message in
            guard message.role.lowercased() == "assistant" else { return false }
            let text = message.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty || message.errorMessage != nil
        }
    }

    private static func assistantHapticEvent(
        for message: OpenClawChatMessage) -> OpenClawChatHaptics.Event?
    {
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant" else {
            return nil
        }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || message.errorMessage != nil else { return nil }
        let stopReason = message.stopReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return stopReason == "error" || stopReason == "aborted" ? .runFailed : .runCompleted
    }

    private func assistantHapticEventAfterLatestUser() -> OpenClawChatHaptics.Event? {
        guard let userIndex = self.messages.lastIndex(where: { $0.role.lowercased() == "user" }) else { return nil }
        let nextIndex = self.messages.index(after: userIndex)
        guard nextIndex < self.messages.endIndex else { return nil }
        return self.messages[nextIndex...].reversed().lazy.compactMap(Self.assistantHapticEvent).first
    }

    private func assistantHapticEvent(after timestamp: Double) -> OpenClawChatHaptics.Event? {
        self.messages.reversed().lazy.compactMap { message in
            guard (message.timestamp ?? 0) >= timestamp else { return nil }
            return Self.assistantHapticEvent(for: message)
        }.first
    }

    /// Narrow seam for the outbox extension: pull durable history after a
    /// flush so acked commands reconcile with their queued bubbles.
    func refreshHistoryAfterOutboxFlush() async {
        await self.refreshHistoryAfterRun()
    }

    @discardableResult
    private func refreshHistoryAfterRun(historyRequest request: HistoryRequest? = nil) async
        -> (applied: Bool, runSnapshotApplied: Bool, supportsInFlightRunState: Bool, hasInFlightRun: Bool)
    {
        let request = request ?? self.beginHistoryRequest()
        do {
            let payload = try await transport.requestHistory(sessionKey: request.session.key)
            let runSnapshotApplied = request.runOwnershipGeneration == self.runOwnershipGeneration &&
                request.id >= self.latestAppliedRunSnapshotRequestID
            let applied = self.applyHistoryPayload(
                payload,
                for: request,
                preservingOptimisticLocalMessages: true)
            let hasInFlightRun = Self.normalizedRunID(payload.inFlightRun?.runId) != nil
            // `hasActiveRun` is session-wide and can be true for an embedded agent run.
            // Its presence capability-gates an authoritative missing chat snapshot, but
            // only `inFlightRun` establishes ownership of the pending chat run.
            let supportsInFlightRunState = hasInFlightRun || payload.sessionInfo?.hasActiveRun != nil
            return (
                applied,
                applied && runSnapshotApplied,
                supportsInFlightRunState,
                hasInFlightRun)
        } catch {
            chatUILogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
            return (false, false, false, false)
        }
    }

    private func armPendingRunTimeout(runId: String) {
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.nextPendingRunTimeoutArmID &+= 1
        let armID = self.nextPendingRunTimeoutArmID
        self.pendingRunTimeoutArmIDs[runId] = armID
        self.pendingRunTimeoutTasks[runId] = Task { [weak self] in
            let timeoutMs = await MainActor.run { self?.pendingRunTimeoutMs ?? 0 }
            do {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            } catch {
                // Rearming or completing a run cancels this task. Never let the
                // retired timeout clear the still-active replacement owner.
                return
            }
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self else { return }
                guard self.pendingRunTimeoutArmIDs[runId] == armID else { return }
                guard self.pendingRuns.contains(runId) else { return }
                self.logDiagnostic(
                    "chat.ui pending timeout sessionKey=\(self.sessionKey) "
                        + "runId=\(runId)")
                self.errorText = "Timed out waiting for a reply; try again or refresh."
                self.clearPendingRun(runId, hapticEvent: .runFailed)
            }
        }
    }

    private func clearPendingRun(
        _ runId: String,
        hapticEvent: OpenClawChatHaptics.Event? = nil)
    {
        let wasPending = self.pendingRuns.contains(runId)
        self.pendingRuns.remove(runId)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
        self.pendingRunTimeoutTasks[runId]?.cancel()
        self.pendingRunTimeoutTasks[runId] = nil
        self.pendingRunTimeoutArmIDs[runId] = nil
        if wasPending {
            self.logDiagnostic(
                "chat.ui pending cleared sessionKey=\(self.sessionKey) "
                    + "runId=\(runId)")
            if self.pendingRuns.isEmpty, let hapticEvent {
                self.haptics.perform(hapticEvent)
            }
        }
    }

    private func clearPendingRuns(
        reason: String?,
        hapticEvent: OpenClawChatHaptics.Event? = nil)
    {
        let runIds = Array(pendingRuns)
        for runId in self.pendingRuns {
            self.pendingRunTimeoutTasks[runId]?.cancel()
        }
        self.pendingRunTimeoutTasks.removeAll()
        self.pendingRunTimeoutArmIDs.removeAll()
        self.pendingRuns.removeAll()
        self.pendingLocalUserEchoMessageIDsByRunID.removeAll()
        if !runIds.isEmpty, let hapticEvent {
            self.haptics.perform(hapticEvent)
        }
        if let reason, !reason.isEmpty {
            self.errorText = reason
            for runId in runIds {
                self.logDiagnostic(
                    "chat.ui pending cleared sessionKey=\(self.sessionKey) "
                        + "runId=\(runId) reason=\(reason)")
            }
        }
    }
}
