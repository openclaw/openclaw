import Foundation
import OpenClawKit
import OSLog

struct SlashFilterCache {
    let query: String
    let filter: OpenClawChatCommandFilter
    let result: [OpenClawChatCommandChoice]
}

private let chatSendingLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

/// One intentional invocation. Retain this object to join or read its result;
/// recreating an OS delivery does not reconstruct this invocation.
@MainActor
public final class OpenClawChatExternalSubmission {
    public let target: OpenClawNativeSessionRef
    public let message: String
    public let operationID = UUID()

    fileprivate enum State {
        case idle
        case running(Task<OpenClawChatSubmissionOutcome, Never>)
        case finished(OpenClawChatSubmissionOutcome)
    }

    fileprivate var state: State = .idle
    fileprivate weak var owner: OpenClawChatViewModel?
    fileprivate var isCurrent: (@Sendable () async -> Bool)?

    public init(target: OpenClawNativeSessionRef, message: String) {
        self.target = target
        self.message = message
    }
}

public enum OpenClawChatSubmissionOutcome: Equatable, Sendable {
    case accepted(runID: String)
    case queued
    case rejected(reason: String)
    case notDispatched(reason: String)
    case cancelled
    case uncertain(reason: String)
}

/// Capture before confirmation. The platform adapter binds both closures to
/// the same authenticated physical connection, not a lookup of "current".
public struct OpenClawChatExternalSubmissionRoute: Sendable {
    public let target: OpenClawNativeSessionRef
    public let lease: OpenClawChatTransportRouteLease
    public let isCurrent: @Sendable () async -> Bool

    public init(
        target: OpenClawNativeSessionRef,
        lease: OpenClawChatTransportRouteLease,
        isCurrent: @escaping @Sendable () async -> Bool)
    {
        self.target = target
        self.lease = lease
        self.isCurrent = isCurrent
    }
}

extension OpenClawChatViewModel {
    /// The platform must bind this view model to the verified route owner.
    /// External submissions never enter the durable outbox or borrow its retry policy.
    public func submit(
        _ submission: OpenClawChatExternalSubmission,
        using route: OpenClawChatExternalSubmissionRoute) async -> OpenClawChatSubmissionOutcome
    {
        switch submission.state {
        case .idle:
            submission.owner = self
            submission.isCurrent = route.isCurrent
            let session = self.currentSessionSnapshot()
            let branchGeneration = self.nextSessionBranchSwitchGeneration
            // Bind and reserve before suspension. Only the first caller owns
            // cancellation; later callers cannot replace the captured route.
            let task = Task {
                await self.performExternalSubmission(
                    submission,
                    using: route,
                    session: session,
                    branchGeneration: branchGeneration)
            }
            submission.state = .running(task)
            let result = await withTaskCancellationHandler {
                await task.value
            } onCancel: {
                task.cancel()
            }
            // Keep every outcome, including known non-dispatch, but release
            // execution captures. A new intentional attempt needs a new object.
            submission.state = .finished(result)
            return result
        case let .running(task):
            return await self.readExternalSubmission(submission) { await task.value }
        case let .finished(result):
            return await self.readExternalSubmission(submission) { result }
        }
    }

    private func readExternalSubmission(
        _ submission: OpenClawChatExternalSubmission,
        result: () async -> OpenClawChatSubmissionOutcome) async -> OpenClawChatSubmissionOutcome
    {
        guard submission.owner === self, let isCurrent = submission.isCurrent,
              await isCurrent(),
              self.matchesExternalTarget(submission.target, session: self.currentSessionSnapshot())
        else {
            return .uncertain(
                reason: "Reconnect to the selected account to check this operation. Do not send it again.")
        }
        let outcome = await result()
        guard await isCurrent(),
              self.matchesExternalTarget(submission.target, session: self.currentSessionSnapshot())
        else {
            return .uncertain(
                reason: "Reconnect to the selected account to check this operation. Do not send it again.")
        }
        return outcome
    }

    private func performExternalSubmission(
        _ submission: OpenClawChatExternalSubmission,
        using route: OpenClawChatExternalSubmissionRoute,
        session: SessionSnapshot,
        branchGeneration: UInt64) async -> OpenClawChatSubmissionOutcome
    {
        guard !Task.isCancelled else { return .cancelled }
        guard submission.target == route.target else {
            return .notDispatched(reason: "The selected action route changed. Select the session again.")
        }
        guard self.matchesExternalTarget(submission.target, session: session) else {
            return .notDispatched(reason: "The selected session changed. Open it again before sending.")
        }
        guard !self.isSubmittingDraft, !self.isSending, !self.hasBlockingRunActivity else {
            return .notDispatched(reason: "Wait for the current chat action before sending.")
        }
        let trimmed = submission.message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .rejected(reason: "Enter a message to send.") }
        let draft = SendDraft(
            input: submission.message,
            attachments: [],
            trimmed: trimmed,
            session: session,
            branchGeneration: branchGeneration,
            source: .external(submission.operationID, route))
        return await self.performSend(draft)
    }

    private func matchesExternalTarget(_ target: OpenClawNativeSessionRef, session: SessionSnapshot) -> Bool {
        self.isCurrentSession(session) &&
            session.key.utf8.elementsEqual(target.sessionKey.utf8) &&
            session.deliveryAgentID?.utf8.elementsEqual(target.agentID.utf8) == true
    }

    public var canSend: Bool {
        !isSubmittingDraft &&
            !isSending &&
            self.attachmentStagingCount == 0 &&
            !self.hasBlockingRunActivity &&
            self.composerModelAvailabilityMessage == nil &&
            self.hasDraftToSend
    }

    public var hasDraftToSend: Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty || !attachments.isEmpty
    }

    /// Only idle text may survive an explicitly verified replacement transport.
    public var canPreserveIdleTextDraft: Bool {
        !self.isSubmittingDraft && !self.isSending && !self.hasBlockingRunActivity &&
            !self.isAborting && self.replyTarget == nil && !self.isAttachmentOwnerPinned
    }

    var hasBlockingRunActivity: Bool {
        pendingRunCount > 0 || self.hasAdvertisedLiveRun ||
            hasActiveSessionRunWithoutChatSnapshot || isSwitchingSessionBranch
    }

    var workingIndicatorIdentity: String {
        let selectedRunIDs = self.liveUsageRunID.map { Set([$0]) } ?? []
        return ChatWorkingIdentity.resolve(
            sessionKey: sessionKey,
            pendingRunIDs: selectedRunIDs,
            localUserMessageIDsByRunID: pendingLocalUserEchoMessageIDsByRunID,
            fallbackGeneration: runOwnershipGeneration)
    }

    public func send() {
        logDiagnostic(
            "chat.ui send invoked sessionKey=\(sessionKey) "
                + "inputLen=\(input.count) attachments=\(attachments.count) "
                + "pending=\(pendingRunCount) sending=\(isSending) "
                + "health=\(healthOK)")
        Task { await self.performSend() }
    }

    public func loadSlashCommandsIfNeeded() {
        guard transport.supportsSlashCommandCatalog else { return }
        guard !hasLoadedSlashCommands, !isLoadingSlashCommands else { return }
        Task { await self.loadSlashCommands(force: false) }
    }

    public func refreshSlashCommands() {
        guard transport.supportsSlashCommandCatalog else { return }
        Task { await self.loadSlashCommands(force: true) }
    }

    public func slashCommandMatches(
        query: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        if let cache = slashFilterCache, cache.query == query, cache.filter == filter {
            return cache.result
        }
        let result = Self.filteredSlashCommands(slashCommands, query: query, filter: filter)
        slashFilterCache = SlashFilterCache(query: query, filter: filter, result: result)
        return result
    }

    public func applySlashCommandSelection(_ command: OpenClawChatCommandChoice) {
        let invocation = command.preferredInvocation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !invocation.isEmpty else { return }
        input = command.acceptsArgs ? "\(invocation) " : invocation
        errorText = nil
    }

    private static let resetTriggers: Set<String> = ["/reset", "/clear"]
    private static let compactTriggers: Set<String> = ["/compact"]

    private func loadSlashCommands(force: Bool) async {
        guard transport.supportsSlashCommandCatalog else { return }
        guard force || !hasLoadedSlashCommands else { return }
        guard !isLoadingSlashCommands else { return }
        let sessionSnapshot = currentSessionSnapshot()
        isLoadingSlashCommands = true
        defer { self.isLoadingSlashCommands = false }

        do {
            let commands = try await transport.listCommands(sessionKey: sessionSnapshot.key)
            guard isCurrentSession(sessionSnapshot) else { return }
            slashCommands = commands
            slashFilterCache = nil
            slashCommandsErrorText = nil
            hasLoadedSlashCommands = true
        } catch {
            guard isCurrentSession(sessionSnapshot) else { return }
            slashCommandsErrorText = error.localizedDescription
        }
    }

    private func waitForSlashCommandLoadIfNeeded() async {
        guard transport.supportsSlashCommandCatalog else { return }
        if !hasLoadedSlashCommands, !isLoadingSlashCommands {
            await self.loadSlashCommands(force: false)
            return
        }
        while isLoadingSlashCommands {
            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return
            }
        }
    }

    private func validateSlashCommandDraftForSend(trimmed: String, hasAttachments: Bool) async -> Bool {
        guard let slashName = Self.slashCommandName(from: trimmed) else {
            return true
        }
        guard !slashName.isEmpty else {
            errorText = "Choose a command."
            return false
        }

        await self.waitForSlashCommandLoadIfNeeded()

        if hasLoadedSlashCommands,
           Self.isKnownSlashCommandText(trimmed, commands: slashCommands),
           hasAttachments
        {
            errorText = "Commands cannot be sent with attachments."
            return false
        }
        return true
    }

    func resetSlashCommandCatalog() {
        slashCommands = []
        slashFilterCache = nil
        slashCommandsErrorText = nil
        hasLoadedSlashCommands = false
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
        guard let commandName = slashCommandName(from: text), !commandName.isEmpty else {
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
                if $0.0 != $1.0 {
                    return $0.0 < $1.0
                }
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

    private func handleLocalSlashCommandIfNeeded(_ command: String, draftInput: String) async -> Bool {
        if command == "/new" {
            if input == draftInput {
                input = ""
            }
            await performStartNewSession(worktree: false)
            return true
        }
        if Self.resetTriggers.contains(command) {
            if input == draftInput {
                input = ""
            }
            await performReset()
            return true
        }
        if Self.compactTriggers.contains(command) {
            if input == draftInput {
                input = ""
            }
            await performCompact()
            return true
        }
        return false
    }

    private static func isLiveOnlyLocalSlashCommand(_ command: String) -> Bool {
        command == "/new" || self.resetTriggers.contains(command) || self.compactTriggers.contains(command)
    }

    private func prepareLiveOnlyLocalSlashCommand(session: SessionSnapshot) async -> Bool {
        // Always probe: a preserved view model can retain stale healthy state
        // after its transport disconnects without a health event. performSend
        // owns the send gate across this await.
        await pollHealthIfNeeded(force: true, sessionSnapshot: session)
        guard isCurrentSession(session) else { return false }
        guard healthOK else {
            errorText = "Connect to the gateway to run this command."
            return false
        }
        return true
    }

    private struct SendDraft {
        enum Source {
            case composer(replyTarget: OpenClawChatReplyTarget?, revision: UInt64)
            case external(UUID, OpenClawChatExternalSubmissionRoute)
        }

        let input: String
        let attachments: [OpenClawPendingAttachment]
        let trimmed: String
        let session: SessionSnapshot
        let branchGeneration: UInt64
        let source: Source

        var isComposer: Bool {
            if case .composer = self.source { return true }
            return false
        }

        var externalRoute: OpenClawChatExternalSubmissionRoute? {
            if case let .external(_, route) = self.source { return route }
            return nil
        }

        var messageText: String {
            self.trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : self.trimmed
        }

        var outgoingMessageText: String {
            guard case let .composer(replyTarget?, _) = self.source else { return self.messageText }
            // Web quotes attachment-only replies with an empty typed prompt;
            // retain that exact trailing separator rather than adding the
            // native attachment fallback text.
            return ChatReplyQuote.prepend(message: self.trimmed, replyTarget: replyTarget)
        }
    }

    private struct LiveSendAttempt {
        let draft: SendDraft
        let runId: String
        let storedThinkingLevel: String
        let encodedAttachments: [OpenClawChatAttachmentPayload]
        let userMessageTimestamp: Double
        let userMessageID: UUID
    }

    private enum AttachmentPersistenceDecision {
        case stop
        case persistIfAvailable
        case liveOnly
    }

    private func performSend() async {
        guard let draft = captureSendDraft() else { return }
        _ = await self.performSend(draft)
    }

    private func performSend(_ draft: SendDraft) async -> OpenClawChatSubmissionOutcome {
        guard !Task.isCancelled else { return .cancelled }
        guard !isSubmittingDraft, !isSending, !self.hasBlockingRunActivity else {
            return .notDispatched(reason: "Wait for the current chat action before sending.")
        }

        // Own every asynchronous validation/probe below. Slash catalog lookup
        // can suspend, so taking this gate later permits duplicate enqueues.
        // It also makes the captured reply selection single-submission; exact
        // target identity keeps a later re-selection safe from completion.
        // Keep it separate from isSending: local /compact checks that flag.
        isSubmittingDraft = true
        defer { self.isSubmittingDraft = false }

        if case let .external(_, route) = draft.source {
            guard await route.isCurrent() else {
                return .notDispatched(reason: "The action route changed. Select the session again.")
            }
            if let outcome = self.externalSubmissionReadiness(draft) { return outcome }
        }
        guard await self.validateSendDraft(draft) else {
            return .rejected(reason: self.errorText ?? "The message was not submitted.")
        }
        guard !Task.isCancelled else { return .cancelled }
        guard self.isCurrentSession(draft.session) else {
            return .notDispatched(reason: "The selected session changed before sending.")
        }

        isSending = true
        isSendingAttachmentDraft = !draft.attachments.isEmpty
        defer {
            self.isSendingAttachmentDraft = false
            self.isSending = false
            self.applyDeferredExternalStateIfReady()
        }

        if let outcome = await self.prepareLiveRoute(for: draft) { return outcome }
        if let reason = self.composerModelAvailabilityMessage {
            logDiagnostic("chat.ui send ignored reason=model-auth sessionKey=\(sessionKey)")
            return .rejected(reason: reason)
        }
        let attempt = self.beginLiveSend(draft)
        return await self.deliverLiveSend(attempt)
    }

    private func captureSendDraft() -> SendDraft? {
        guard !isSubmittingDraft, !isSending else {
            logDiagnostic("chat.ui send ignored reason=sending sessionKey=\(sessionKey)")
            return nil
        }
        guard self.attachmentStagingCount == 0 else {
            // File reads and image processing suspend before publishing the
            // attachment. Do not let a programmatic send overtake that owner.
            logDiagnostic("chat.ui send ignored reason=attachment-staging sessionKey=\(sessionKey)")
            return nil
        }
        guard !self.hasBlockingRunActivity else {
            logDiagnostic(
                "chat.ui send ignored reason=pending sessionKey=\(sessionKey) "
                    + "pending=\(pendingRunCount) "
                    + "activeWithoutSnapshot=\(hasActiveSessionRunWithoutChatSnapshot)")
            return nil
        }
        let input = self.input
        let attachments = self.attachments
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else {
            logDiagnostic("chat.ui send ignored reason=empty sessionKey=\(sessionKey)")
            return nil
        }
        return SendDraft(
            input: input,
            attachments: attachments,
            trimmed: trimmed,
            session: currentSessionSnapshot(),
            branchGeneration: self.nextSessionBranchSwitchGeneration,
            source: .composer(
                replyTarget: Self.isSlashCommandDraft(trimmed) ? nil : replyTarget,
                revision: composerRevision(for: sessionKey)))
    }

    private func validateSendDraft(_ draft: SendDraft) async -> Bool {
        let command = draft.trimmed.lowercased()
        if Self.isLiveOnlyLocalSlashCommand(command) {
            guard draft.isComposer else {
                errorText = "Open the session to run this command."
                return false
            }
            let canRunCommand = await prepareLiveOnlyLocalSlashCommand(session: draft.session)
            guard canRunCommand else { return false }
        }
        if case let .composer(_, revision) = draft.source,
           await self.handleLocalSlashCommandIfNeeded(command, draftInput: draft.input)
        {
            self.recordSuccessfulInput(
                draft.trimmed,
                submittedRevision: revision,
                sessionKey: draft.session.key)
            return false
        }
        return await self.validateSlashCommandDraftForSend(
            trimmed: draft.trimmed,
            hasAttachments: !draft.attachments.isEmpty)
    }

    private func prepareLiveRoute(for draft: SendDraft) async -> OpenClawChatSubmissionOutcome? {
        guard case let .composer(_, revision) = draft.source else {
            return self.externalSubmissionReadiness(draft)
        }
        let sessionKey = draft.session.key
        if !healthOK {
            await pollHealthIfNeeded(force: true, sessionSnapshot: draft.session)
            guard isCurrentSession(draft.session) else {
                return .notDispatched(reason: "The selected session changed before sending.")
            }
            // Offline capture: queue the full draft durably instead of
            // dropping user text or attachment bytes.
            if !healthOK, outbox != nil {
                logDiagnostic(
                    "chat.ui send queued offline sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
                let accepted = await enqueueOutboxCommand(
                    text: draft.outgoingMessageText,
                    draftInput: draft.input,
                    draftRevision: revision,
                    draftAttachments: draft.attachments,
                    session: draft.session)
                if accepted {
                    self.finishAcceptedComposerSend(draft)
                }
                return accepted ? .queued : .notDispatched(reason: errorText ?? "Could not queue the message.")
            }
        }

        let mustPreserveOutboxOrder = self.hasPendingOutboxCommandsForCurrentSession
        let attachmentDecision = await attachmentPersistenceDecision(
            draft,
            mustPreserveOutboxOrder: mustPreserveOutboxOrder)
        let shouldPersistAttachmentDraft: Bool
        switch attachmentDecision {
        case .stop:
            return .notDispatched(reason: errorText ?? "Could not verify the attachment route.")
        case .persistIfAvailable:
            shouldPersistAttachmentDraft = true
        case .liveOnly:
            shouldPersistAttachmentDraft = false
        }

        // FIFO across the reconnect boundary: while this session still has
        // queued/sending outbox rows — or restore has not yet adopted rows
        // persisted by an earlier process, so we must assume a backlog — a
        // live send would race ahead of them. Route it through the outbox so
        // the queue stays the single ordering authority; it flushes
        // immediately while healthy, so the turn still sends right away.
        // Failed rows are parked user decisions and do not hold new sends
        // hostage. Outbox-backed attachments always take this persist-first
        // path so a crash cannot erase their only remaining bytes. Deliberately
        // session-scoped: other sessions are separate conversations with no
        // ordering contract.
        if outbox != nil,
           shouldPersistAttachmentDraft || mustPreserveOutboxOrder
        {
            logDiagnostic(
                "chat.ui send routed behind outbox sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
            let accepted = await enqueueOutboxCommand(
                text: draft.outgoingMessageText,
                draftInput: draft.input,
                draftRevision: revision,
                draftAttachments: draft.attachments,
                session: draft.session)
            if accepted {
                self.finishAcceptedComposerSend(draft)
            }
            return accepted ? .queued : .notDispatched(reason: errorText ?? "Could not queue the message.")
        }
        return nil
    }

    private func externalSubmissionReadiness(_ draft: SendDraft) -> OpenClawChatSubmissionOutcome? {
        guard case let .external(_, route) = draft.source else { return nil }
        guard self.matchesExternalTarget(route.target, session: draft.session),
              !self.isSwitchingSessionBranch,
              self.nextSessionBranchSwitchGeneration == draft.branchGeneration,
              let capturedContract = route.lease.sessionRoutingContract,
              let selectedContract = draft.session.sessionRoutingContract,
              capturedContract.utf8.elementsEqual(selectedContract.utf8),
              route.lease.supportsSessionSettingsCAS,
              self.verifiedSessionSettingsExpectation(
                  sessionKey: route.target.sessionKey, agentID: route.target.agentID) != nil
        else {
            return .notDispatched(reason: "Reconnect to verify this action's session and permissions.")
        }
        guard self.healthOK else {
            return .notDispatched(reason: "Reconnect before sending this action. It has not been queued.")
        }
        // The iOS outbox namespace does not prove principal ownership. Native
        // actions cannot persist there, or overtake rows adopted during restore.
        guard !self.hasPendingOutboxCommandsForCurrentSession else {
            return .notDispatched(reason: "Resolve queued messages in this chat before sending this action.")
        }
        return nil
    }

    private func attachmentPersistenceDecision(
        _ draft: SendDraft,
        mustPreserveOutboxOrder: Bool) async -> AttachmentPersistenceDecision
    {
        guard !draft.attachments.isEmpty,
              healthOK,
              outbox != nil
        else {
            return draft.attachments.isEmpty ? .liveOnly : .persistIfAvailable
        }
        let routeResult = await transport.acquireOutboxRouteLease()
        guard isCurrentSession(draft.session) else { return .stop }
        guard case let .unavailable(reason, allowsLiveSend) = routeResult else {
            return .persistIfAvailable
        }
        guard allowsLiveSend else {
            errorText = "Could not verify this attachment's delivery route. Reconnect, then try again."
            return .stop
        }
        guard hasRestoredOutboxMessages else {
            errorText = "Restoring queued messages. Try again in a moment."
            return .stop
        }
        guard !mustPreserveOutboxOrder else {
            // A legacy gateway cannot drain the existing durable rows, so keep
            // this new attachment in the composer behind them.
            errorText = reason ?? OpenClawChatTransportUpgradeMessage.routingContract
            return .stop
        }
        // Older healthy gateways can send attachments live but cannot safely
        // replay them. Preserve that shipped live-only path.
        return .liveOnly
    }

    private func beginLiveSend(_ draft: SendDraft) -> LiveSendAttempt {
        errorText = nil
        let runId: String = if case let .external(operationID, _) = draft.source {
            operationID.uuidString
        } else {
            UUID().uuidString
        }
        let storedThinkingLevel = preferredThinkingLevel
        pendingRuns.insert(runId)
        logDiagnostic(
            "chat.ui send queued sessionKey=\(draft.session.key) "
                + "localRunId=\(runId) pending=\(pendingRunCount)")
        pendingToolCallsById = [:]
        updateStreamingAssistantText(nil)

        // Production attachment sends enter the durable outbox above. Fixture,
        // preview, and embedded transports may intentionally have no outbox;
        // keep their established live-only attachment path available.
        let encodedAttachments = draft.attachments.map { attachment in
            OpenClawChatAttachmentPayload(
                type: attachment.type,
                mimeType: attachment.mimeType,
                fileName: attachment.fileName,
                content: attachment.data.base64EncodedString())
        }
        let userContent = Self.userContent(
            messageText: draft.outgoingMessageText,
            attachments: draft.attachments,
            encodedAttachments: encodedAttachments)
        let userMessageTimestamp = Date().timeIntervalSince1970 * 1000
        let userMessageID = UUID()
        appendMessage(
            OpenClawChatMessage(
                id: userMessageID,
                role: "user",
                content: userContent,
                timestamp: userMessageTimestamp,
                idempotencyKey: "\(runId):user"))
        pendingLocalUserEchoMessageIDsByRunID[runId] = userMessageID
        runMessageScopesByRunID[runId] = currentRunMessageScope()

        // Clear input immediately for responsive UX (before network await).
        if draft.isComposer {
            if input == draft.input {
                input = ""
            }
            let sentAttachmentIDs = Set(draft.attachments.map(\.id))
            attachments.removeAll { sentAttachmentIDs.contains($0.id) }
        }

        return LiveSendAttempt(
            draft: draft,
            runId: runId,
            storedThinkingLevel: storedThinkingLevel,
            encodedAttachments: encodedAttachments,
            userMessageTimestamp: userMessageTimestamp,
            userMessageID: userMessageID)
    }

    private static func userContent(
        messageText: String,
        attachments: [OpenClawPendingAttachment],
        encodedAttachments: [OpenClawChatAttachmentPayload]) -> [OpenClawChatMessageContent]
    {
        var content: [OpenClawChatMessageContent] = [
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
        for (attachment, payload) in zip(attachments, encodedAttachments) {
            content.append(
                OpenClawChatMessageContent(
                    type: payload.type,
                    text: nil,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: payload.mimeType,
                    fileName: payload.fileName,
                    durationSeconds: attachment.durationSeconds,
                    content: AnyCodable(payload.content),
                    id: nil,
                    name: nil,
                    arguments: nil))
        }
        return content
    }

    private func deliverLiveSend(_ attempt: LiveSendAttempt) async -> OpenClawChatSubmissionOutcome {
        let sessionKey = attempt.draft.session.key
        let acceptedRunSessionID = self.sessionId
        var durableSessionSettingsExpectation: OpenClawChatSessionSettingsExpectation?
        var requestStarted = false
        do {
            if let settingsError = await waitForCapabilitySettingsBarrier(in: sessionKey) {
                await self.handleLiveSendFailure(
                    NSError(
                        domain: "OpenClawChatCapabilitySettings",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: settingsError]),
                    attempt: attempt,
                    canPreserveInOutbox: false)
                return .rejected(reason: settingsError)
            }
            guard isCurrentSession(attempt.draft.session) else {
                return .notDispatched(reason: "The selected session changed before sending.")
            }
            let sendSessionSettingsExpectation: OpenClawChatSessionSettingsExpectation?
            if case let .external(_, route) = attempt.draft.source {
                let settingsTarget = self.currentModelPatchTarget()
                let settingsRevision = self.settingsPatchRevisionsByTarget[settingsTarget, default: 0]
                guard await route.isCurrent(),
                      self.settingsPatchRevisionsByTarget[settingsTarget, default: 0] == settingsRevision,
                      self.inFlightSettingsPatchCountsByTarget[settingsTarget] == nil,
                      self.externalSubmissionReadiness(attempt.draft) == nil,
                      let expectation = self.verifiedSessionSettingsExpectation(
                          sessionKey: route.target.sessionKey, agentID: route.target.agentID)
                else { throw OpenClawChatTransportSendError.notDispatched }
                try Task.checkCancellation()
                sendSessionSettingsExpectation = expectation
            } else {
                sendSessionSettingsExpectation = self.composerSessionSettingsExpectation()
            }
            durableSessionSettingsExpectation = self.durableSessionSettingsExpectation()
            logDiagnostic(
                "chat.ui transport send start sessionKey=\(sessionKey) "
                    + "localRunId=\(attempt.runId)")
            let thinkingLevel = effectiveThinkingLevelForSend(attempt.storedThinkingLevel)
            let response: OpenClawChatSendResponse
            requestStarted = true
            switch attempt.draft.source {
            case let .external(_, route):
                response = try await route.lease.sendMessage(
                    sessionKey: sessionKey,
                    agentID: attempt.draft.session.deliveryAgentID,
                    expectedSessionSettings: sendSessionSettingsExpectation,
                    message: attempt.draft.outgoingMessageText,
                    thinking: thinkingLevel,
                    idempotencyKey: attempt.runId,
                    attachments: attempt.encodedAttachments)
            case .composer:
                response = try await transport.sendMessage(
                    sessionKey: sessionKey,
                    target: OpenClawChatSendTarget(
                        agentID: attempt.draft.session.deliveryAgentID,
                        expectedSessionRoutingContract: attempt.draft.session.sessionRoutingContract,
                        expectedSessionSettings: sendSessionSettingsExpectation),
                    message: attempt.draft.outgoingMessageText,
                    thinking: thinkingLevel,
                    idempotencyKey: attempt.runId,
                    attachments: attempt.encodedAttachments)
            }
            if !attempt.draft.isComposer {
                if !response.runId.isEmpty,
                   response.status == "error" || (response.status == "timeout" && !response.isAbortedRun)
                {
                    await self.handleLiveSendFailure(
                        NSError(
                            domain: "OpenClawChatSubmission",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "Run failed to start (\(response.status))."]),
                        attempt: attempt)
                    return .rejected(reason: "Run failed to start (\(response.status)).")
                }
                guard ["started", "in_flight", "ok"].contains(response.status) || response.isAbortedRun,
                      !response.runId.isEmpty
                else {
                    await self.handleLiveSendFailure(URLError(.badServerResponse), attempt: attempt)
                    return .uncertain(reason: "The Gateway did not confirm acceptance. Check the chat before retrying.")
                }
            }
            if !response.runId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               ["started", "in_flight", "ok"].contains(response.status) || response.isAbortedRun
            {
                // The receipt keeps its captured session even if presentation changed during send.
                response.onAcceptedRun?(acceptedRunSessionID)
            }
            await self.handleLiveSendResponse(response, attempt: attempt)
            // The ACK belongs to the captured target even if presentation was
            // replaced while it arrived. Never turn known acceptance into retry.
            return response.status == "error" || (response.status == "timeout" && !response.isAbortedRun)
                ? .rejected(reason: "Run failed to start (\(response.status)).")
                : .accepted(runID: response.runId)
        } catch {
            await self.handleLiveSendFailure(
                error,
                attempt: attempt,
                durableSessionSettingsExpectation: durableSessionSettingsExpectation)
            if error is OpenClawChatTransportSendError || !requestStarted {
                return Task.isCancelled ? .cancelled : .notDispatched(
                    reason: "The action route changed before sending. Select the session again.")
            }
            if let responseError = error as? GatewayResponseError {
                if responseError.detailsReason == "EXPECTED_PROFILE_MISMATCH" {
                    // Only explicit admission evidence proves this attempt had no
                    // effect. A handler may have accepted work before losing its owner.
                    guard responseError.details["execution"]?.stringValue == "not_started" else {
                        return .uncertain(
                            reason: "The selected account changed. "
                                + "Delivery is unconfirmed; check the chat before retrying.")
                    }
                    return .notDispatched(reason: responseError.localizedDescription)
                }
                return .rejected(reason: error.localizedDescription)
            }
            return .uncertain(reason: "Delivery is unconfirmed. Check the selected chat before sending again.")
        }
    }

    private func canPresentLiveSend(_ attempt: LiveSendAttempt) async -> Bool {
        if let route = attempt.draft.externalRoute, await !route.isCurrent() { return false }
        // Route validation suspends. Check the captured session afterwards.
        return self.isCurrentSession(attempt.draft.session)
    }

    private func handleLiveSendResponse(
        _ response: OpenClawChatSendResponse,
        attempt: LiveSendAttempt) async
    {
        guard await self.canPresentLiveSend(attempt) else { return }
        let sessionKey = attempt.draft.session.key
        logDiagnostic(
            "chat.ui transport send accepted sessionKey=\(sessionKey) "
                + "localRunId=\(attempt.runId) remoteRunId=\(response.runId)")
        if response.status != "error", response.status != "timeout" {
            haptics.perform(.messageSent)
            self.finishAcceptedComposerSend(attempt.draft)
        }
        let reusedRunAlreadyFinal = response.runId == attempt.runId
            ? false
            : self.adoptRemoteRunID(response.runId, replacing: attempt.runId)

        if attempt.draft.isComposer {
            await self.reconcileLiveSendResponse(
                response,
                attempt: attempt,
                reusedRunAlreadyFinal: reusedRunAlreadyFinal)
        } else {
            // Native actions return the ACK without waiting for history or run
            // completion. The existing chat owner keeps following the run.
            if response.status != "ok", response.status != "error", response.status != "timeout",
               !reusedRunAlreadyFinal
            {
                armPendingRunOwner(
                    runId: response.runId,
                    sessionSnapshot: attempt.draft.session,
                    userMessageTimestamp: attempt.userMessageTimestamp)
            }
            Task {
                guard await self.canPresentLiveSend(attempt) else { return }
                await self.reconcileLiveSendResponse(
                    response,
                    attempt: attempt,
                    reusedRunAlreadyFinal: reusedRunAlreadyFinal)
            }
        }
    }

    private func reconcileLiveSendResponse(
        _ response: OpenClawChatSendResponse,
        attempt: LiveSendAttempt,
        reusedRunAlreadyFinal: Bool) async
    {
        guard await self.canPresentLiveSend(attempt) else { return }
        if response.status == "ok" || response.isAbortedRun {
            // A cached abort can precede the user transcript commit. Remove the
            // optimistic row first; only authoritative history may put it back.
            if response.isAbortedRun { self.removePendingLocalUserEcho(for: response.runId) }
            let historyContext = beginHistoryRequest(for: attempt.draft.session)
            await refreshHistoryAfterRun(
                historyRequest: historyContext,
                externalRoute: attempt.draft.externalRoute)
            guard await self.canPresentLiveSend(attempt) else { return }
            if !finishPendingRunIfTerminalSendAck(response) {
                finishPendingRunAfterTerminalOkSendAck(response)
            }
            return
        }
        guard !finishPendingRunIfTerminalSendAck(response),
              !reusedRunAlreadyFinal
        else {
            return
        }

        let historyContext = beginHistoryRequest(for: attempt.draft.session)
        let refresh = await refreshHistoryAfterRun(
            historyRequest: historyContext,
            externalRoute: attempt.draft.externalRoute)
        guard await self.canPresentLiveSend(attempt) else { return }
        if refresh.hasInFlightRun || (refresh.applied && !refresh.runSnapshotApplied) ||
            !clearPendingRunIfAssistantMessagePresent(
                runId: response.runId,
                after: attempt.userMessageTimestamp)
        {
            armPendingRunOwner(
                runId: response.runId,
                sessionSnapshot: attempt.draft.session,
                userMessageTimestamp: attempt.userMessageTimestamp)
        }
    }

    private func adoptRemoteRunID(_ remoteRunId: String, replacing localRunId: String) -> Bool {
        let pendingUserMessageID = pendingLocalUserEchoMessageIDsByRunID.removeValue(forKey: localRunId)
        let localRunScope = runMessageScopesByRunID.removeValue(forKey: localRunId)
        clearPendingRun(localRunId)
        pendingRuns.insert(remoteRunId)
        // The gateway can reuse an identical active run without writing this
        // second turn. Move the optimistic row onto that durable identity,
        // collapsing it if the canonical row is already here.
        let rekeyedUserEcho = rekeyLocalUserEcho(
            messageID: pendingUserMessageID,
            runId: remoteRunId)
        pendingLocalUserEchoMessageIDsByRunID[remoteRunId] = rekeyedUserEcho?.pendingMessageID
        let remoteRunScope = rekeyedUserEcho?.scope ?? localRunScope ?? currentRunMessageScope()
        runMessageScopesByRunID[remoteRunId] = remoteRunScope
        rescopeProvisionalFinalMessages(runId: remoteRunId, scope: remoteRunScope)
        let reusedRunAlreadyFinal = hasRecordedFinalMessage(runId: remoteRunId)
        if reusedRunAlreadyFinal {
            clearPendingRun(remoteRunId, hapticEvent: .runCompleted)
            pendingToolCallsById = [:]
            updateStreamingAssistantText(nil)
        } else {
            armPendingRunOwner(
                runId: remoteRunId,
                sessionSnapshot: remoteRunScope.session,
                userMessageTimestamp: remoteRunScope.latestUserTurn?.timestamp)
        }
        return reusedRunAlreadyFinal
    }

    private func handleLiveSendFailure(
        _ error: Error,
        attempt: LiveSendAttempt,
        durableSessionSettingsExpectation: OpenClawChatSessionSettingsExpectation? = nil,
        canPreserveInOutbox: Bool = true) async
    {
        guard await self.canPresentLiveSend(attempt) else { return }
        if attempt.draft.isComposer,
           canPreserveInOutbox,
           let durableSessionSettingsExpectation,
           attempt.encodedAttachments.isEmpty,
           !(error is GatewayResponseError)
        {
            runMessageScopesByRunID.removeValue(forKey: attempt.runId)
            clearPendingRun(attempt.runId)
            let deliveryIsAmbiguous = !(error is OpenClawChatTransportSendError)
            let preserved = await preserveFailedLiveSend(
                runId: attempt.runId,
                text: attempt.draft.outgoingMessageText,
                thinking: effectiveThinkingLevelForSend(attempt.storedThinkingLevel),
                messageID: attempt.userMessageID,
                session: attempt.draft.session,
                expectedSessionSettings: durableSessionSettingsExpectation,
                deliveryIsAmbiguous: deliveryIsAmbiguous)
            if preserved {
                self.finishAcceptedComposerSend(attempt.draft)
                applyTransportHealth(false)
                let outcome = deliveryIsAmbiguous ? "delivery unconfirmed" : "queued after route change"
                logDiagnostic(
                    "chat.ui send \(outcome) sessionKey=\(attempt.draft.session.key) "
                        + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
                return
            }
            guard isCurrentSession(attempt.draft.session) else { return }
            // Refused persistence (queue full / broken store): restore the
            // draft so the text is not lost with the failed bubble.
            if input.isEmpty {
                input = attempt.draft.input
            }
        }
        self.restoreDraftAfterLiveSendFailure(attempt)
        removePendingLocalUserEcho(for: attempt.runId)
        runMessageScopesByRunID.removeValue(forKey: attempt.runId)
        errorText = error.localizedDescription
        clearPendingRun(attempt.runId, hapticEvent: .runFailed)
        logDiagnostic(
            "chat.ui send failed sessionKey=\(attempt.draft.session.key) "
                + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
        chatSendingLogger.error("chat transport send failed \(error.localizedDescription, privacy: .public)")
    }

    private func restoreDraftAfterLiveSendFailure(_ attempt: LiveSendAttempt) {
        guard attempt.draft.isComposer else { return }
        if attempt.encodedAttachments.isEmpty, input.isEmpty {
            input = attempt.draft.input
        } else if !attempt.encodedAttachments.isEmpty {
            if input.isEmpty {
                input = attempt.draft.input
            }
            let currentAttachmentIDs = Set(attachments.map(\.id))
            let removedDraftAttachments = attempt.draft.attachments.filter {
                !currentAttachmentIDs.contains($0.id)
            }
            attachments.insert(contentsOf: removedDraftAttachments, at: 0)
        }
    }

    private static func isSlashCommandDraft(_ text: String) -> Bool {
        text.hasPrefix("/") && !text.hasPrefix("//")
    }

    private func finishAcceptedComposerSend(_ draft: SendDraft) {
        guard case let .composer(replyTarget, revision) = draft.source else { return }
        self.recordSuccessfulInput(
            draft.trimmed,
            transcriptEcho: draft.outgoingMessageText,
            submittedRevision: revision,
            sessionKey: draft.session.key)
        self.consumeReplyTarget(replyTarget)
    }
}
