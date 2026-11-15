import Foundation

/// Durable drafts: the client-state store owns each session's draft, and
/// `input`/`attachments` buffer only the visible key. Text with no stored
/// draft (no store, key unresolved, load pending or unreadable, or a save
/// that failed) stays in `draftsBySession` for this launch.
extension OpenClawChatViewModel {
    static let composerDraftSaveDelay: Duration = .milliseconds(300)

    struct ComposerDraftSync {
        var loadingKey: String?
        var load: Task<Void, Never>?
        var saveTimer: Task<Void, Never>?
        /// A send captured before its draft loaded owns that text until it settles.
        var send: Task<Void, Never>?
        var savedRevision: UInt64?
        /// Switch-away saves still in flight or failed; their text stays in `draftsBySession`.
        var unsavedDraftRevisions: [String: UInt64] = [:]
        /// Restored text newer than the stored row, which it replaces when the load lands.
        var replacesStoredDraftKey: String?
        var insertingAttachmentIDs: Set<OpenClawPendingAttachment.ID> = []
        var isApplying = false
    }

    /// Owns the visible composer's revision and recall state. A bound draft
    /// keeps its key until a switch, so a later identity change cannot split them.
    var visibleComposerKey: String {
        self.composerDraftKey ?? self.composerSessionKey(for: self.sessionKey)
    }

    /// Tail of the installation-wide draft write chain.
    var composerDraftWrites: Task<Void, Never>? {
        self.composerDraftStore?.databases.composerDraftWrites.tail
    }

    /// Nil until the draft's owner is known: an agent, plus the routing
    /// contract for `main`/`global` aliases. Earlier edits stay in memory and
    /// are appended to the stored draft once the key resolves.
    var durableComposerDraftKey: String? {
        let qualifiedOwner = OpenClawChatSessionKey.agentID(from: self.sessionKey)
        guard qualifiedOwner ?? self.explicitSessionAgentID ?? self.activeAgentId ?? self.agentCatalog?.defaultId != nil
        else { return nil }
        let parts = self.sessionKey.split(separator: ":", maxSplits: 2)
        let alias = qualifiedOwner != nil && parts.count == 3 ? String(parts[2]) : self.sessionKey
        if ["main", "global"].contains(alias.lowercased()),
           OpenClawChatSessionRoutingContract.parse(
               self.agentCatalog?.sessionRoutingContract ?? self.sessionRoutingContract) == nil
        {
            return nil
        }
        return self.composerSessionKey(for: self.sessionKey)
    }

    /// Binds the composer to the visible session's stored draft once its key
    /// resolves. An identity change leaves the previous draft with its own key.
    func syncComposerDraftKey() {
        guard self.composerDraftStore != nil, !self.isTransportDetached,
              let key = self.durableComposerDraftKey,
              key != self.composerDraftKey, key != self.composerDraftSync.loadingKey
        else { return }
        if self.composerDraftKey != nil {
            // An unsaved attachment keeps the current draft until it is stored or removed.
            guard !self.isAttachmentOwnerPinned else { return }
            self.unbindComposerDraft()
        }
        self.loadComposerDraft(key: key)
    }

    /// Starts saving the visible draft to its key and empties the composer.
    /// Until that save lands, this launch keeps the text as if no draft were stored.
    func unbindComposerDraft() {
        if let pending = self.saveVisibleComposerDraft() {
            if pending.text.isEmpty {
                self.draftsBySession.removeValue(forKey: pending.key)
            } else {
                self.draftsBySession[pending.key] = pending.text
            }
            self.composerDraftSync.unsavedDraftRevisions[pending.key] = pending.revision
        }
        self.composerDraftSync.saveTimer?.cancel()
        self.cancelComposerDraftLoad()
        self.composerDraftSync.savedRevision = nil
        self.composerDraftAttachmentPositions = [:]
        self.composerDraftSync.insertingAttachmentIDs = []
        self.composerDraftKey = nil
        self.applyComposerDraft(text: "", attachments: [])
    }

    func cancelComposerDraftLoad() {
        self.composerDraftSync.load?.cancel()
        self.composerDraftSync.load = nil
        self.composerDraftSync.loadingKey = nil
    }

    /// Saves now instead of after the typing pause, e.g. when iOS backgrounds
    /// the app, and retries attachments whose earlier save failed.
    public func flushComposerDraftText() {
        self.saveVisibleComposerDraft()
        guard let key = self.composerDraftKey, !self.isTransportDetached else { return }
        for attachment in self.attachments where self.composerDraftAttachmentPositions[attachment.id] == nil {
            self.persistComposerDraftAttachment(attachment, key: key)
        }
    }

    /// Nil when the stored text is already current. A failed save leaves the
    /// saved revision behind, so the next flush, background or quit retries it.
    @discardableResult
    private func saveVisibleComposerDraft() -> (key: String, text: String, revision: UInt64)? {
        self.composerDraftSync.saveTimer?.cancel()
        self.composerDraftSync.saveTimer = nil
        guard let store = self.composerDraftStore, let key = self.composerDraftKey, !self.isTransportDetached
        else { return nil }
        let revision = self.composerRevisionsBySession[key, default: 0]
        guard self.composerDraftSync.savedRevision != revision else { return nil }
        // The draft beneath recall mode, never a recalled history entry.
        let text = (self.inputHistoriesBySession[key] ?? ChatInputHistory())
            .draftForSessionSwitch(currentDraft: self.input)
        self.chainComposerDraftWrite { [weak self] in
            guard await store.saveComposerDraftText(key: key, text: text, revision: revision), let self
            else { return }
            if self.composerDraftKey == key {
                self.composerDraftSync.savedRevision = revision
            }
            if self.composerDraftSync.unsavedDraftRevisions[key] == revision {
                self.composerDraftSync.unsavedDraftRevisions[key] = nil
                self.draftsBySession.removeValue(forKey: key)
            }
        }
        return (key, text, revision)
    }

    /// Saves now and waits until the write lands, e.g. before macOS quits.
    public func persistComposerDraft() async {
        self.flushComposerDraftText()
        await self.composerDraftWrites?.value
    }

    func scheduleComposerDraftSave() {
        guard self.composerDraftKey != nil, !self.isTransportDetached else { return }
        self.composerDraftSync.saveTimer?.cancel()
        self.composerDraftSync.saveTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.composerDraftSaveDelay)
            guard !Task.isCancelled else { return }
            self?.flushComposerDraftText()
        }
    }

    /// Settles earlier draft writes so an enqueue can clear the draft in its
    /// own transaction. Nil unless the send was captured from the stored draft.
    /// An attachment send pins the session, so the positions stay this draft's.
    func composerDraftConsumption(
        key: String,
        revision: UInt64,
        attachments: [OpenClawPendingAttachment]) async -> OpenClawChatComposerDraftConsumption?
    {
        guard self.composerDraftKey == key else { return nil }
        self.flushComposerDraftText()
        await self.composerDraftWrites?.value
        return OpenClawChatComposerDraftConsumption(
            draftKey: key,
            revision: revision,
            attachmentPositions: attachments.compactMap { self.composerDraftAttachmentPositions[$0.id] })
    }

    /// The enqueue transaction already removed the attachments it consumed.
    func noteComposerDraftConsumed(_ consumption: OpenClawChatComposerDraftConsumption) {
        guard self.composerDraftKey == consumption.draftKey else { return }
        let consumed = Set(consumption.attachmentPositions)
        self.composerDraftAttachmentPositions = self.composerDraftAttachmentPositions
            .filter { !consumed.contains($0.value) }
    }

    /// Edit and restore: moves an outbox row into the draft for `key`, inside
    /// the draft write chain. The typed draft is saved first, so the store
    /// appends below what the composer shows. `isStillAllowed` runs right
    /// before the composer changes. The composer shows the merged draft before
    /// the store write, so any save queued meanwhile keeps the moved text; a
    /// refusal takes it back out. Accepted: a refusal racing a keystroke or
    /// session switch in that window, or a kill after a background flush saved
    /// the merged text but before the rollback save, leaves the text in the
    /// draft beside its row. Another composer bound to the same key (a second
    /// macOS window) keeps last-writer-wins.
    func moveOutboxCommandToComposerDraft(
        _ command: OpenClawChatOutboxCommand,
        key: String,
        restoring failure: OpenClawChatOutboxRetryExpectation?,
        notice: String?,
        isStillAllowed: @escaping @MainActor () -> Bool) async -> OpenClawChatOutboxMoveResult
    {
        guard let store = self.composerDraftStore else { return .unavailable }
        self.flushComposerDraftText()
        return await withCheckedContinuation { continuation in
            self.chainComposerDraftWrite { [weak self] in
                guard let self, self.composerDraftKey == key, !self.isTransportDetached, isStillAllowed() else {
                    continuation.resume(returning: .unavailable)
                    return
                }
                // The save above landed and nothing was typed since: the stored draft matches the composer.
                let isSaved = self.composerDraftSync.savedRevision == self.composerRevisionsBySession[key, default: 0]
                var history = self.inputHistoriesBySession[key] ?? ChatInputHistory()
                let base = history.draftForSessionSwitch(currentDraft: self.input)
                history.resetNavigation()
                self.inputHistoriesBySession[key] = history
                let merged = OpenClawChatComposerDraft.appending(command.text, to: base)
                let moved = command.attachments.map(Self.pendingAttachment)
                let movedIDs = Set(moved.map(\.id))
                // The store inserts these rows; a flush meanwhile must not insert them again.
                self.composerDraftSync.insertingAttachmentIDs.formUnion(movedIDs)
                self.applyComposerDraft(text: merged, attachments: self.attachments + moved)
                let revision = self.composerRevisionsBySession[key, default: 0] &+ 1
                self.composerRevisionsBySession[key] = revision
                let result = await store.cancelCommand(
                    id: command.id,
                    moveToDraftKey: key,
                    revision: revision,
                    restoring: failure)
                if case .moved = result {
                    // Edit retires an older restore notice; set before a switch can return early.
                    self.composerNoticesBySession[key] = notice
                }
                // After a switch the stored draft already has the move; the
                // unbind save carried the merged composer.
                guard self.composerDraftKey == key else {
                    continuation.resume(returning: result)
                    return
                }
                self.composerDraftSync.insertingAttachmentIDs.subtract(movedIDs)
                if case let .moved(stored) = result {
                    for (attachment, row) in zip(moved, stored) {
                        if self.attachments.contains(where: { $0.id == attachment.id }) {
                            self.composerDraftAttachmentPositions[attachment.id] = row.position
                        } else {
                            await store.deleteComposerDraftAttachment(key: key, position: row.position)
                        }
                    }
                    if isSaved, self.composerRevisionsBySession[key] == revision {
                        self.composerDraftSync.savedRevision = revision
                    } else {
                        self.composerRevisionsBySession[key, default: 0] &+= 1
                        self.flushComposerDraftText()
                    }
                } else {
                    let text = self.input == merged ? base : self.input
                    self.applyComposerDraft(
                        text: text,
                        attachments: self.attachments.filter { !movedIDs.contains($0.id) })
                    self.composerRevisionsBySession[key, default: 0] &+= 1
                    self.flushComposerDraftText()
                }
                // Positions are set or the attachments are gone, so a deferred switch can apply.
                self.applyDeferredExternalStateIfReady()
                continuation.resume(returning: result)
            }
        }
    }

    /// Why a restored message is back in this session's composer; cleared by the next edit or send.
    public var composerNotice: String? {
        self.composerNoticesBySession[self.visibleComposerKey]
    }

    func clearComposerNotice() {
        let key = self.visibleComposerKey
        if self.composerNoticesBySession[key] != nil {
            self.composerNoticesBySession.removeValue(forKey: key)
        }
    }

    func composerAttachmentsChanged(from previous: [OpenClawPendingAttachment]) {
        guard !self.composerDraftSync.isApplying else { return }
        self.clearComposerNotice()
        guard let store = self.composerDraftStore, !self.isTransportDetached,
              let key = self.composerDraftKey
        else { return }
        let currentIDs = Set(self.attachments.map(\.id))
        for attachment in previous where !currentIDs.contains(attachment.id) {
            guard let position = self.composerDraftAttachmentPositions.removeValue(forKey: attachment.id)
            else { continue }
            self.chainComposerDraftWrite {
                await store.deleteComposerDraftAttachment(key: key, position: position)
            }
        }
        let previousIDs = Set(previous.map(\.id))
        for attachment in self.attachments where !previousIDs.contains(attachment.id) {
            self.persistComposerDraftAttachment(attachment, key: key)
        }
    }

    private func persistComposerDraftAttachment(_ attachment: OpenClawPendingAttachment, key: String) {
        guard let store = self.composerDraftStore,
              self.composerDraftSync.insertingAttachmentIDs.insert(attachment.id).inserted
        else { return }
        let stored = OpenClawChatOutboxAttachment(
            type: attachment.type,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            data: attachment.data,
            durationSeconds: attachment.durationSeconds)
        let id = attachment.id
        let revision = self.composerRevisionsBySession[key, default: 0]
        self.chainComposerDraftWrite { [weak self] in
            let result = await store.insertComposerDraftAttachment(key: key, attachment: stored, revision: revision)
            // After a switch the row stays with the draft it was added to.
            guard let self, self.composerDraftKey == key else { return }
            self.composerDraftSync.insertingAttachmentIDs.remove(id)
            switch result {
            case let .inserted(position):
                if self.attachments.contains(where: { $0.id == id }) {
                    self.composerDraftAttachmentPositions[id] = position
                    self.applyDeferredExternalStateIfReady()
                } else {
                    await store.deleteComposerDraftAttachment(key: key, position: position)
                }
            case .draftFull:
                self.attachments.removeAll { $0.id == id }
                self.errorText = String(format: String(localized: "Too large to send: %@"), stored.fileName)
            case .unavailable:
                // Without a stored position the attachment pins this chat; the next flush retries it.
                guard self.attachments.contains(where: { $0.id == id }) else { return }
                self.errorText = String(
                    format: String(
                        localized: "Could not save %@ with this draft. Send or remove it before switching chats."),
                    stored.fileName)
            }
        }
    }

    private func chainComposerDraftWrite(_ write: @escaping @MainActor @Sendable () async -> Void) {
        self.composerDraftStore?.databases.composerDraftWrites.append(write)
    }

    private func loadComposerDraft(key: String) {
        guard let store = self.composerDraftStore else { return }
        self.composerDraftSync.loadingKey = key
        // Reads after every draft write already started, including a replaced model's.
        let writes = self.composerDraftWrites
        self.composerDraftSync.load = Task { [weak self] in
            await writes?.value
            let draft = await store.loadComposerDraft(key: key)
            // Unbound sends never write the store, so the read stays current.
            let send = self?.composerDraftSync.send
            await send?.value
            guard let self, !Task.isCancelled, self.composerDraftSync.loadingKey == key else { return }
            self.composerDraftSync.loadingKey = nil
            // Unreadable storage keeps edits in memory rather than saving over a draft never read.
            guard let draft else { return }
            self.applyLoadedComposerDraft(draft, key: key)
        }
    }

    /// Input typed (or seeded by the presenter) before the load landed is
    /// appended to the stored draft, never overwritten by it. Text restored
    /// from a switch-away save is newer than the row, so it replaces the row.
    private func applyLoadedComposerDraft(_ draft: OpenClawChatComposerDraft, key: String) {
        var history = self.inputHistoriesBySession[key] ?? ChatInputHistory()
        let typed = history.draftForSessionSwitch(currentDraft: self.input)
        let replacesStoredText = self.composerDraftSync.replacesStoredDraftKey == key
        self.composerDraftSync.replacesStoredDraftKey = nil
        let text = if replacesStoredText {
            typed
        } else if typed.isEmpty || typed == draft.text {
            draft.text
        } else {
            draft.text.isEmpty ? typed : draft.text + "\n\n" + typed
        }
        // Seeding from the row keeps a detached or recreated model's late
        // clear from deleting text saved after it.
        var revision = max(self.composerRevisionsBySession[key, default: 0], draft.revision)
        if text != draft.text { revision &+= 1 }
        self.composerRevisionsBySession[key] = revision
        self.composerDraftSync.savedRevision = draft.revision
        var positions: [OpenClawPendingAttachment.ID: Int] = [:]
        let loaded = draft.attachments.map { stored in
            let attachment = Self.pendingAttachment(stored.attachment)
            positions[attachment.id] = stored.position
            return attachment
        }
        let typedAttachments = self.attachments
        self.composerDraftAttachmentPositions = positions
        self.composerDraftKey = key
        if text != typed {
            history.resetNavigation()
            self.inputHistoriesBySession[key] = history
            self.applyComposerDraft(text: text, attachments: loaded + typedAttachments)
        } else {
            self.applyComposerDraft(text: self.input, attachments: loaded + typedAttachments)
        }
        for attachment in typedAttachments {
            self.persistComposerDraftAttachment(attachment, key: key)
        }
        if text != draft.text {
            self.flushComposerDraftText()
        }
        self.applyDeferredExternalStateIfReady()
        // A page may have proved a rejected row before this draft bound.
        self.restoreRejectedOutboxMessageIfProven()
    }

    private static func pendingAttachment(_ stored: OpenClawChatOutboxAttachment) -> OpenClawPendingAttachment {
        OpenClawPendingAttachment(
            url: nil,
            data: stored.data,
            fileName: stored.fileName,
            mimeType: stored.mimeType,
            type: stored.type,
            preview: stored.mimeType.hasPrefix("image/") ? OpenClawPlatformImage(data: stored.data) : nil,
            durationSeconds: stored.durationSeconds)
    }

    private func applyComposerDraft(text: String, attachments: [OpenClawPendingAttachment]) {
        self.isApplyingRecalledInput = true
        self.composerDraftSync.isApplying = true
        self.input = text
        self.attachments = attachments
        self.composerDraftSync.isApplying = false
        self.isApplyingRecalledInput = false
    }
}
