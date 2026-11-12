import Foundation

/// Durable drafts: the client-state store owns each session's draft, and
/// `input`/`attachments` buffer only the visible key. Text with no stored
/// draft yet (no store, key unresolved, load pending or unreadable) stays in
/// `draftsBySession` for this launch.
extension OpenClawChatViewModel {
    static let composerDraftSaveDelay: Duration = .milliseconds(300)

    struct ComposerDraftSync {
        var loadingKey: String?
        var load: Task<Void, Never>?
        var saveTimer: Task<Void, Never>?
        /// A send captured before its draft loaded owns that text until it settles.
        var send: Task<Void, Never>?
        var savedRevision: UInt64?
        var attachmentPositions: [OpenClawPendingAttachment.ID: Int] = [:]
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
            self.unbindComposerDraft()
        }
        self.loadComposerDraft(key: key)
    }

    /// Writes the visible draft to its key and empties the composer.
    func unbindComposerDraft() {
        self.flushComposerDraftText()
        self.cancelComposerDraftLoad()
        self.composerDraftSync.savedRevision = nil
        self.composerDraftSync.attachmentPositions = [:]
        self.composerDraftKey = nil
        self.applyComposerDraft(text: "", attachments: [])
    }

    func cancelComposerDraftLoad() {
        self.composerDraftSync.load?.cancel()
        self.composerDraftSync.load = nil
        self.composerDraftSync.loadingKey = nil
    }

    /// Saves now instead of after the typing pause, e.g. when iOS backgrounds the app.
    public func flushComposerDraftText() {
        self.composerDraftSync.saveTimer?.cancel()
        self.composerDraftSync.saveTimer = nil
        guard let store = self.composerDraftStore, let key = self.composerDraftKey, !self.isTransportDetached
        else { return }
        let revision = self.composerRevisionsBySession[key, default: 0]
        guard self.composerDraftSync.savedRevision != revision else { return }
        self.composerDraftSync.savedRevision = revision
        // The draft beneath recall mode, never a recalled history entry.
        let text = (self.inputHistoriesBySession[key] ?? ChatInputHistory())
            .draftForSessionSwitch(currentDraft: self.input)
        self.chainComposerDraftWrite {
            await store.saveComposerDraftText(key: key, text: text, revision: revision)
        }
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
            attachmentPositions: attachments.compactMap { self.composerDraftSync.attachmentPositions[$0.id] })
    }

    /// The enqueue transaction already removed the attachments it consumed.
    func noteComposerDraftConsumed(_ consumption: OpenClawChatComposerDraftConsumption) {
        guard self.composerDraftKey == consumption.draftKey else { return }
        let consumed = Set(consumption.attachmentPositions)
        self.composerDraftSync.attachmentPositions = self.composerDraftSync.attachmentPositions
            .filter { !consumed.contains($0.value) }
    }

    func composerAttachmentsChanged(from previous: [OpenClawPendingAttachment]) {
        guard let store = self.composerDraftStore, !self.composerDraftSync.isApplying, !self.isTransportDetached,
              let key = self.composerDraftKey
        else { return }
        let currentIDs = Set(self.attachments.map(\.id))
        for attachment in previous where !currentIDs.contains(attachment.id) {
            guard let position = self.composerDraftSync.attachmentPositions.removeValue(forKey: attachment.id)
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
        guard let store = self.composerDraftStore else { return }
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
            switch result {
            case let .inserted(position):
                if self.attachments.contains(where: { $0.id == id }) {
                    self.composerDraftSync.attachmentPositions[id] = position
                } else {
                    await store.deleteComposerDraftAttachment(key: key, position: position)
                }
            case .draftFull:
                self.attachments.removeAll { $0.id == id }
                self.errorText = String(format: String(localized: "Too large to send: %@"), stored.fileName)
            case .unavailable:
                // Storage errors are logged by the store; the attachment stays for this launch.
                break
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
    /// appended to the stored draft, never overwritten by it.
    private func applyLoadedComposerDraft(_ draft: OpenClawChatComposerDraft, key: String) {
        var history = self.inputHistoriesBySession[key] ?? ChatInputHistory()
        let typed = history.draftForSessionSwitch(currentDraft: self.input)
        let text = typed.isEmpty || typed == draft.text
            ? draft.text
            : draft.text.isEmpty ? typed : draft.text + "\n\n" + typed
        // Seeding from the row keeps a detached or recreated model's late
        // clear from deleting text saved after it.
        var revision = max(self.composerRevisionsBySession[key, default: 0], draft.revision)
        if text != draft.text { revision &+= 1 }
        self.composerRevisionsBySession[key] = revision
        self.composerDraftSync.savedRevision = draft.revision
        var positions: [OpenClawPendingAttachment.ID: Int] = [:]
        let loaded = draft.attachments.map { stored in
            let attachment = OpenClawPendingAttachment(
                url: nil,
                data: stored.attachment.data,
                fileName: stored.attachment.fileName,
                mimeType: stored.attachment.mimeType,
                type: stored.attachment.type,
                preview: stored.attachment.mimeType.hasPrefix("image/")
                    ? OpenClawPlatformImage(data: stored.attachment.data) : nil,
                durationSeconds: stored.attachment.durationSeconds)
            positions[attachment.id] = stored.position
            return attachment
        }
        let typedAttachments = self.attachments
        self.composerDraftSync.attachmentPositions = positions
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
