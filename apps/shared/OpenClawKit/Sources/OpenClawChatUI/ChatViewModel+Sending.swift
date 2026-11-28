import Foundation
import OpenClawKit
import OSLog

struct SlashFilterCache {
    let query: String
    let filter: OpenClawChatCommandFilter
    let result: [OpenClawChatCommandChoice]
}

private let chatSendingLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")
let localSessionCommands: Set<String> = ["/new", "/reset", "/clear", "/compact"]

extension OpenClawChatViewModel {
    /// The text older builds sent with an attachment-only message. Attachment-only sends now carry
    /// empty text, as the Control UI does; history from older builds still hides this exact text.
    nonisolated static let legacyAttachmentOnlyMessageText = "See attached."

    /// Whether `text` is the legacy attachment-only fallback on a message that has attachments.
    nonisolated static func isLegacyAttachmentOnlyText(_ text: String, in message: OpenClawChatMessage) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines) == self.legacyAttachmentOnlyMessageText &&
            message.content.contains(where: \.isInlineAttachment)
    }

    public var canSend: Bool {
        !self.usesWebConversation &&
            !isSubmittingDraft &&
            !isSending &&
            self.composerPreparationAllowsSend &&
            !self.isSwitchingSessionBranch &&
            (!self.hasBlockingRunActivity || self.canSendDuringRun) &&
            self.composerModelAvailabilityMessage == nil &&
            (self.hasDraftToSend || !self.composerPreparingAttachments.isEmpty)
    }

    /// Text and attachments go out during a reply through the outbox, which carries the queue mode
    /// and the attachment bytes, as the Control UI does. Local session commands wait for the reply.
    var canSendDuringRun: Bool {
        let command = Self.slashCommandName(from: self.input).map { "/\($0)" } ?? ""
        return self.outbox != nil && !localSessionCommands.contains(command)
    }

    var canChooseSendMode: Bool {
        self.hasBlockingRunActivity && self.canSend &&
            !Self.isSlashCommandDraft(self.input.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var sendModeChoices: [OpenClawChatQueueMode] {
        guard self.canChooseSendMode else { return [] }
        switch defaultFollowUpMode?.rawValue ?? currentSessionEntry()?.effectiveQueueMode {
        case "steer": return [.followup]
        case "followup": return [.steer]
        // Other Gateway modes and older Gateways do not have a single opposite.
        default: return [.steer, .followup]
        }
    }

    public var hasDraftToSend: Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty || !self.composerAttachments.isEmpty
    }

    var hasBlockingRunActivity: Bool {
        pendingRunCount > 0 || self.hasAdvertisedLiveRun ||
            hasActiveSessionRunWithoutChatSnapshot || isSwitchingSessionBranch
    }

    var workingIndicatorIdentity: String {
        let selectedRunIDs = self.liveUsageRunID.map { Set([$0]) } ?? []
        var inputs = pendingLocalUserEchoMessageIDsByRunID
        // Adopting the Gateway's copy of the input ends its echo entry but keeps its ID. Without this the
        // line was rebuilt mid-turn: its claw restarted and its label went blank.
        if let run = self.liveUsageRunID, inputs[run] == nil,
           let input = self.messages.last(where: { $0.role == "user" && $0.workRunID == run })
        {
            inputs[run] = input.id
        }
        return ChatWorkingIdentity.resolve(
            sessionKey: sessionKey,
            pendingRunIDs: selectedRunIDs,
            localUserMessageIDsByRunID: inputs,
            fallbackGeneration: runOwnershipGeneration)
    }

    @discardableResult
    public func send(queueMode: OpenClawChatQueueMode? = nil) -> Task<Void, Never>? {
        guard !self.usesWebConversation else { return nil }
        // Reserve the accepted draft before scheduling work so initial route
        // hydration cannot retire its owner before asynchronous validation starts.
        guard let draft = captureSendDraft(queueMode: queueMode) else { return nil }
        isSubmittingDraft = true
        isSendingAttachmentDraft = !draft.attachments.isEmpty || !draft.preparationIDs.isEmpty
        self.statusStrip.didSend()
        self.showOptimisticSend(draft)
        let task = Task { await self.performSend(draft) }
        self.composerDraftSync.send = task
        return task
    }

    public func loadSlashCommandsIfNeeded() {
        guard transport.supportsSlashCommandCatalog, !hasLoadedSlashCommands, !isLoadingSlashCommands else { return }
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
            errorText = String(localized: "Choose a command.")
            return false
        }

        await self.waitForSlashCommandLoadIfNeeded()

        if hasLoadedSlashCommands,
           Self.isKnownSlashCommandText(trimmed, commands: slashCommands),
           hasAttachments
        {
            errorText = String(localized: "Commands can’t include attachments.")
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
        if commands.contains(where: { self.command($0, matchesInvocationName: commandName) }) {
            return true
        }
        guard commandName == "skill" else { return false }
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 2 else { return false }
        let skillName = String(parts[1]).lowercased()
        return commands.contains { command in
            command.source == .skill && self.command(command, matchesInvocationName: skillName)
        }
    }

    private static func command(
        _ command: OpenClawChatCommandChoice,
        matchesInvocationName name: String) -> Bool
    {
        if command.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == name {
            return true
        }
        return command.textAliases.contains { alias in
            self.slashCommandName(from: alias) == name
        }
    }

    private static func filteredSlashCommands(
        _ commands: [OpenClawChatCommandChoice],
        query rawQuery: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let withoutSlash = trimmed.hasPrefix("/") ? String(trimmed.dropFirst()) : trimmed
        let normalized = withoutSlash.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let targetsSkills = normalized == "skill" || normalized.hasPrefix("skill ")
        let query = targetsSkills
            ? String(normalized.dropFirst("skill".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            : normalized
        let effectiveFilter: OpenClawChatCommandFilter = targetsSkills && filter == .all ? .skills : filter
        return commands.enumerated()
            .compactMap { index, command -> (Int, Int, OpenClawChatCommandChoice)? in
                switch effectiveFilter {
                case .commands where command.source == .skill, .skills where command.source != .skill:
                    return nil
                default:
                    break
                }
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
        if command.source.rawValue.contains(query) {
            return 3
        }
        return nil
    }

    private struct SendDraft {
        let input: String
        /// Ready at the tap; the tiles in `preparationIDs` join once staged.
        var attachments: [OpenClawPendingAttachment]
        var preparationIDs: [UUID]
        let trimmed: String
        let session: SessionSnapshot
        let replyTarget: OpenClawChatReplyTarget?
        let queueMode: OpenClawChatQueueMode?
        let composerSessionKey: String
        let composerRevision: UInt64
        /// The send's run or outbox command ID, so the row shown at the tap is the one that is sent.
        let sendID = UUID().uuidString
        /// The row shown at the tap. Nil for a local session command, which is not a chat message.
        let optimisticMessageID: UUID?
        /// The composer had a stored draft at the tap; without one its text lives only in memory.
        let isDraftStored: Bool

        /// An attachment-only send carries empty text, as the Control UI sends it.
        var outgoingMessageText: String {
            guard let replyTarget else { return self.trimmed }
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

    private func performSend(_ captured: SendDraft) async {
        // Admission covers every validation/probe; local /compact uses the separate isSending flag.
        defer {
            // Whatever stopped the send before it was sent or queued gives the message back.
            self.giveBackOptimisticSend(captured)
            self.isSendingAttachmentDraft = false
            self.isSubmittingDraft = false
        }

        guard let draft = await self.stagedSendDraft(captured) else { return }
        guard await self.validateSendDraft(draft) else { return }

        isSending = true
        defer {
            self.isSendingAttachmentDraft = false
            self.isSending = false
            self.giveBackOptimisticSend(captured)
            self.applyDeferredExternalStateIfReady()
        }

        guard await self.prepareNewChatDraftSettings(for: draft.session) else { return }
        guard await self.prepareLiveRoute(for: draft) else { return }
        guard await self.validateAttachmentBudgetForSend(draft.attachments, session: draft.session) else { return }
        guard self.composerModelAvailabilityMessage == nil else {
            return
        }
        let attempt = self.beginLiveSend(draft)
        await self.deliverLiveSend(attempt)
    }

    /// Shows the message in the transcript at the tap and empties the composer for the next one. The stored
    /// draft keeps the text and attachments until the send consumes them, so a crash meanwhile loses nothing.
    private func showOptimisticSend(_ draft: SendDraft) {
        guard let messageID = draft.optimisticMessageID else { return }
        self.flushComposerDraftText()
        // Not an edit: the stored draft and its revision stay as they are until the send settles.
        self.isApplyingRecalledInput = true
        self.input = ""
        self.isApplyingRecalledInput = false
        self.clearComposerNotice()
        self.heldAttachmentIDs = Set(draft.attachments.map(\.id) + draft.preparationIDs)
        #if os(iOS)
        inlineVideos.remember(draft.attachments, messageKey: Self.outboxUserIdempotencyKey(draft.sendID))
        #endif
        // A tile still preparing has no bytes yet; its kind comes from the MIME type and the bubble draws
        // it as pending.
        let pending = draft.preparationIDs.compactMap { id in self.preparingAttachments.first { $0.id == id } }
            .map { tile in
                OpenClawChatMessageContent(
                    type: "file",
                    mimeType: tile.mimeType,
                    fileName: tile.fileName,
                    durationSeconds: tile.durationSeconds)
            }
        self.optimisticSendMessageID = messageID
        appendMessage(OpenClawChatMessage(
            id: messageID,
            role: "user",
            content: self.optimisticContent(draft) + pending,
            timestamp: Date().timeIntervalSince1970 * 1000,
            idempotencyKey: Self.outboxUserIdempotencyKey(draft.sendID)))
        self.localSendRevision &+= 1
    }

    private func optimisticContent(_ draft: SendDraft) -> [OpenClawChatMessageContent] {
        let encoded = draft.attachments.map { attachment in
            OpenClawChatAttachmentPayload(
                type: attachment.type,
                mimeType: attachment.mimeType,
                fileName: attachment.fileName,
                content: attachment.data.base64EncodedString())
        }
        return Self.userContent(
            messageText: draft.outgoingMessageText,
            attachments: draft.attachments,
            encodedAttachments: encoded)
    }

    /// Waits for the tiles the send took to be staged, then shows their bytes in the message. A tile that
    /// fails or is removed ends the send; the tile shows why once the message is back in the composer.
    private func stagedSendDraft(_ captured: SendDraft) async -> SendDraft? {
        guard !captured.preparationIDs.isEmpty else { return captured }
        let ids = Set(captured.preparationIDs)
        while self.preparingAttachments.contains(where: { ids.contains($0.id) && $0.failure == nil }) {
            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return nil
            }
        }
        let staged = captured.preparationIDs.compactMap { id in self.attachments.first { $0.id == id } }
        guard self.isCurrentSession(captured.session), staged.count == ids.count else { return nil }
        var draft = captured
        draft.attachments += staged
        draft.preparationIDs = []
        #if os(iOS)
        inlineVideos.remember(draft.attachments, messageKey: Self.outboxUserIdempotencyKey(draft.sendID))
        #endif
        if let messageID = draft.optimisticMessageID, let index = messages.firstIndex(where: { $0.id == messageID }) {
            var message = messages[index]
            message.content = self.optimisticContent(draft)
            messages[index] = message
            markTimelineChanged()
        }
        return draft
    }

    /// The send took the message: its run or outbox row now owns the transcript row and the attachments.
    private func settleOptimisticSend(_ draft: SendDraft) {
        guard draft.optimisticMessageID != nil, self.optimisticSendMessageID == draft.optimisticMessageID else {
            return
        }
        self.optimisticSendMessageID = nil
        self.heldAttachmentIDs = []
    }

    /// A send stopped before it was sent or queued: the row leaves the transcript and the message goes back to
    /// the composer, above anything typed since. The failing step already said why. Accepted: a chat switch
    /// before this leaves the text in that chat's stored draft, saved at the tap, unless text typed there
    /// after the tap replaced it.
    private func giveBackOptimisticSend(_ draft: SendDraft) {
        guard let messageID = draft.optimisticMessageID, self.optimisticSendMessageID == messageID else { return }
        self.optimisticSendMessageID = nil
        self.heldAttachmentIDs = []
        self.removeMessage(id: messageID)
        guard self.isCurrentSession(draft.session), self.visibleComposerKey == draft.composerSessionKey else {
            if !draft.isDraftStored {
                self.draftsBySession[draft.composerSessionKey] = OpenClawChatComposerDraft.appending(
                    self.draftsBySession[draft.composerSessionKey] ?? "",
                    to: draft.input)
            }
            return
        }
        if self.input.isEmpty, self.composerRevision(for: self.sessionKey) == draft.composerRevision {
            // Nothing typed since the tap, so the stored draft still matches.
            self.isApplyingRecalledInput = true
            self.input = draft.input
            self.isApplyingRecalledInput = false
        } else {
            self.input = OpenClawChatComposerDraft.appending(self.input, to: draft.input)
        }
    }

    private func captureSendDraft(queueMode: OpenClawChatQueueMode?) -> SendDraft? {
        guard !isSubmittingDraft, !isSending else {
            return nil
        }
        guard self.composerPreparationAllowsSend else {
            // File reads and image processing suspend before publishing the attachment. A send takes the
            // tiles still preparing and waits for them; without a tile it cannot claim that read.
            return nil
        }
        guard !self.isSwitchingSessionBranch,
              !self.hasBlockingRunActivity || self.canSendDuringRun
        else {
            return nil
        }
        let input = self.input
        let attachments = self.composerAttachments
        let preparationIDs = self.composerPreparingAttachments.map(\.id)
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty || !preparationIDs.isEmpty else {
            return nil
        }
        // A menu choice belongs to this message. Slash commands own their
        // intent, and a transport without an outbox cannot preserve the choice.
        if queueMode != nil {
            guard self.canSendDuringRun, !Self.isSlashCommandDraft(trimmed) else { return nil }
        }
        return SendDraft(
            input: input,
            attachments: attachments,
            preparationIDs: preparationIDs,
            trimmed: trimmed,
            session: currentSessionSnapshot(),
            replyTarget: Self.isSlashCommandDraft(trimmed) ? nil : replyTarget,
            queueMode: queueMode ?? (
                self.hasBlockingRunActivity && self.canSendDuringRun && !Self.isSlashCommandDraft(trimmed)
                    ? defaultFollowUpMode : nil),
            composerSessionKey: visibleComposerKey,
            composerRevision: composerRevision(for: sessionKey),
            optimisticMessageID: localSessionCommands.contains(trimmed.lowercased()) ? nil : UUID(),
            isDraftStored: composerDraftKey != nil)
    }

    private func validateSendDraft(_ draft: SendDraft) async -> Bool {
        let command = draft.trimmed.lowercased()
        if localSessionCommands.contains(command) {
            // Preserved presentations can retain healthy state after a silent disconnect.
            await pollHealthIfNeeded(force: true, sessionSnapshot: draft.session)
            guard isCurrentSession(draft.session) else { return false }
            guard healthOK else {
                errorText = String(localized: "Connect to run this command.")
                return false
            }
            if input == draft.input { input = "" }
            self.flushComposerDraftText()
            switch command {
            case "/new": await performStartNewSession(inheritCurrentSession: true, worktree: false)
            case "/compact": await performCompact()
            default: await performReset()
            }
            self.recordSuccessfulInput(
                draft.trimmed,
                submittedRevision: draft.composerRevision,
                sessionKey: draft.composerSessionKey)
            return false
        }
        return await self.validateSlashCommandDraftForSend(
            trimmed: draft.trimmed,
            hasAttachments: !draft.attachments.isEmpty)
    }

    private func prepareLiveRoute(for draft: SendDraft) async -> Bool {
        if !healthOK {
            await pollHealthIfNeeded(force: true, sessionSnapshot: draft.session)
            guard isCurrentSession(draft.session) else { return false }
            // Offline capture: queue the full draft durably instead of
            // dropping user text or attachment bytes.
            if !healthOK, outbox != nil {
                await self.enqueueOutboxDraft(draft)
                return false
            }
        }

        let mustPreserveOutboxOrder = self.hasPendingOutboxCommandsForCurrentSession
        let attachmentDecision = await attachmentPersistenceDecision(
            draft,
            mustPreserveOutboxOrder: mustPreserveOutboxOrder)
        let shouldPersistAttachmentDraft: Bool
        switch attachmentDecision {
        case .stop:
            return false
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
           draft.queueMode != nil || self.hasBlockingRunActivity ||
           shouldPersistAttachmentDraft || mustPreserveOutboxOrder
        {
            // Busy sends reuse durable delivery without replacing the active
            // run's stream or tools. A menu choice also takes this path if the
            // original run completed while the menu was open.
            await self.enqueueOutboxDraft(draft)
            return false
        }
        return true
    }

    private func enqueueOutboxDraft(_ draft: SendDraft) async {
        let accepted = await self.enqueueOutboxCommand(
            id: draft.sendID,
            text: draft.outgoingMessageText,
            draftInput: draft.input,
            draftRevision: draft.composerRevision,
            draftComposerKey: draft.composerSessionKey,
            draftAttachments: draft.attachments,
            queueMode: draft.queueMode,
            session: draft.session)
        if accepted {
            self.settleOptimisticSend(draft)
            self.finishAcceptedComposerSend(draft)
        }
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
            errorText = String(localized: "Couldn’t send this attachment. Reconnect, then try again.")
            return .stop
        }
        guard hasRestoredOutboxMessages else {
            errorText = String(localized: "Restoring queued messages. Try again in a moment.")
            return .stop
        }
        guard !mustPreserveOutboxOrder else {
            // A legacy gateway cannot drain the existing durable rows, so keep
            // this new attachment in the composer behind them.
            if let reason { chatSendingLogger.error("attachment send held: \(reason, privacy: .public)") }
            errorText = OpenClawChatTransportUpgradeMessage.routingContract
            return .stop
        }
        // Older healthy gateways can send attachments live but cannot safely
        // replay them. Preserve that shipped live-only path.
        return .liveOnly
    }

    private func beginLiveSend(_ draft: SendDraft) -> LiveSendAttempt {
        errorText = nil
        let runId = draft.sendID
        let storedThinkingLevel = preferredThinkingLevel
        pendingRuns.insert(runId)
        self.clearStreamingActivity()

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
        #if os(iOS)
        inlineVideos.remember(draft.attachments, messageKey: Self.outboxUserIdempotencyKey(runId))
        #endif
        let userContent = Self.userContent(
            messageText: draft.outgoingMessageText,
            attachments: draft.attachments,
            encodedAttachments: encodedAttachments)
        let userMessageTimestamp = Date().timeIntervalSince1970 * 1000
        // The row shown at the tap becomes the sent message in place.
        let userMessageID = draft.optimisticMessageID ?? UUID()
        // History requested before this send cannot replace its optimistic row.
        invalidateHistorySnapshots()
        let userMessage = OpenClawChatMessage(
            id: userMessageID,
            role: "user",
            content: userContent,
            timestamp: userMessageTimestamp,
            idempotencyKey: "\(runId):user")
        if let index = messages.firstIndex(where: { $0.id == userMessageID }) {
            messages[index] = userMessage
            markTimelineChanged()
        } else {
            appendMessage(userMessage)
            self.localSendRevision &+= 1
        }
        pendingLocalUserEchoMessageIDsByRunID[runId] = userMessageID
        runMessageScopesByRunID[runId] = currentRunMessageScope()

        // The composer emptied at the tap without touching the stored draft; with nothing typed since, the
        // cleared composer is now an edit to save.
        if input.isEmpty, composerRevision(for: sessionKey) == draft.composerRevision {
            self.noteComposerInputChanged()
        }
        let sentAttachmentIDs = Set(draft.attachments.map(\.id))
        attachments.removeAll { sentAttachmentIDs.contains($0.id) }
        self.settleOptimisticSend(draft)
        // A live send has no outbox insert to clear its draft, so write the cleared composer now.
        self.flushComposerDraftText()

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
            OpenClawChatMessageContent(type: "text", text: messageText),
        ]
        for (attachment, payload) in zip(attachments, encodedAttachments) {
            content.append(
                OpenClawChatMessageContent(
                    type: payload.type,
                    mimeType: payload.mimeType,
                    fileName: payload.fileName,
                    sizeBytes: attachment.data.count,
                    durationSeconds: attachment.durationSeconds,
                    content: AnyCodable(payload.content)))
        }
        return content
    }

    private func deliverLiveSend(_ attempt: LiveSendAttempt) async {
        let sessionKey = attempt.draft.session.key
        var preparedDelivery: (settings: OpenClawChatSessionSettingsExpectation, thinking: String)?
        do {
            if let settingsError = await waitForCapabilitySettingsBarrier(
                in: sessionKey,
                preferenceWaitLimit: Self.settingsFlushBeforeSend)
            {
                await self.handleLiveSendFailure(
                    NSError(
                        domain: "OpenClawChatCapabilitySettings",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: settingsError]),
                    attempt: attempt)
                return
            }
            guard isCurrentSession(attempt.draft.session) else { return }
            let sendSessionSettingsExpectation = self.composerSessionSettingsExpectation()
            let thinkingLevel = effectiveThinkingLevelForSend(attempt.storedThinkingLevel)
            preparedDelivery = (self.durableSessionSettingsExpectation(), thinkingLevel)
            let response = try await transport.sendMessage(
                sessionKey: sessionKey,
                target: OpenClawChatSendTarget(
                    agentID: attempt.draft.session.deliveryAgentID,
                    expectedSessionRoutingContract: attempt.draft.session.sessionRoutingContract,
                    expectedSessionSettings: sendSessionSettingsExpectation),
                message: attempt.draft.outgoingMessageText,
                thinking: thinkingLevel,
                idempotencyKey: attempt.runId,
                attachments: attempt.encodedAttachments)
            guard isCurrentSession(attempt.draft.session) else {
                if response.status != "error", response.status != "timeout" {
                    self.finishAcceptedComposerSend(attempt.draft)
                }
                return
            }
            await self.handleLiveSendResponse(response, attempt: attempt)
        } catch {
            await self.handleLiveSendFailure(
                error,
                attempt: attempt,
                preparedDelivery: preparedDelivery)
        }
    }

    private func handleLiveSendResponse(
        _ response: OpenClawChatSendResponse,
        attempt: LiveSendAttempt) async
    {
        if response.status != "error", response.status != "timeout" {
            haptics.perform(.messageSent)
            self.finishAcceptedComposerSend(attempt.draft)
        }
        let reusedRunAlreadyFinal = response.runId == attempt.runId
            ? false
            : self.adoptRemoteRunID(response.runId, replacing: attempt.runId)

        let terminalOK = response.status == "ok"
        guard terminalOK || (!finishPendingRunIfTerminalSendAck(response) && !reusedRunAlreadyFinal) else { return }

        let historyContext = beginHistoryRequest(for: attempt.draft.session)
        let refresh = await refreshHistoryAfterRun(historyRequest: historyContext)
        guard isCurrentSession(attempt.draft.session) else { return }
        if terminalOK {
            finishPendingRunAfterTerminalOkSendAck(response)
            return
        }
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
            self.clearStreamingActivity()
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
        preparedDelivery: (settings: OpenClawChatSessionSettingsExpectation, thinking: String)? = nil) async
    {
        let admissionRejected = Self.isRetryableAdmissionRejection(error)
        // Known-unsent work still belongs to its captured session after navigation.
        guard isCurrentSession(attempt.draft.session) || admissionRejected else { return }
        if let preparedDelivery,
           attempt.encodedAttachments.isEmpty,
           !(error is GatewayResponseError) || admissionRejected,
           !(error is OpenClawChatSendOwnershipError)
        {
            runMessageScopesByRunID.removeValue(forKey: attempt.runId)
            clearPendingRun(attempt.runId)
            let deliveryIsAmbiguous = !(error is OpenClawChatTransportSendError) && !admissionRejected
            if admissionRejected {
                applyTransportHealth(false)
            }
            let preserved = await preserveFailedLiveSend(
                runId: attempt.runId,
                text: attempt.draft.outgoingMessageText,
                thinking: preparedDelivery.thinking,
                messageID: attempt.userMessageID,
                session: attempt.draft.session,
                expectedSessionSettings: preparedDelivery.settings,
                deliveryIsAmbiguous: deliveryIsAmbiguous)
            if preserved {
                self.finishAcceptedComposerSend(attempt.draft)
                guard isCurrentSession(attempt.draft.session) else { return }
                applyTransportHealth(false)
                let outcome = deliveryIsAmbiguous ? "delivery unconfirmed" : "queued after route change"
                logDiagnostic(
                    "chat.ui send \(outcome) sessionKey=\(attempt.draft.session.key) "
                        + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
                return
            }
            guard isCurrentSession(attempt.draft.session) else { return }
        }
        self.restoreDraftAfterLiveSendFailure(attempt)
        removePendingLocalUserEcho(for: attempt.runId)
        runMessageScopesByRunID.removeValue(forKey: attempt.runId)
        // The message is back in the composer, so no line under a message says it failed.
        errorText = String(localized: "Couldn’t send your message.")
        clearPendingRun(attempt.runId, hapticEvent: .runFailed)
        logDiagnostic(
            "chat.ui send failed sessionKey=\(attempt.draft.session.key) "
                + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
        chatSendingLogger.error("chat transport send failed \(error.localizedDescription, privacy: .public)")
    }

    private func restoreDraftAfterLiveSendFailure(_ attempt: LiveSendAttempt) {
        if input.isEmpty {
            input = attempt.draft.input
        }
        if !attempt.encodedAttachments.isEmpty {
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
        if self.newChatDraft?.key == draft.session.key { self.newChatDraft = nil }
        self.recordSuccessfulInput(
            draft.trimmed,
            transcriptEcho: draft.outgoingMessageText,
            submittedRevision: draft.composerRevision,
            sessionKey: draft.composerSessionKey)
        self.consumeReplyTarget(draft.replyTarget)
    }
}
