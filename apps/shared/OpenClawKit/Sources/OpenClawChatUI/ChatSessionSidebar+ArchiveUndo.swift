#if os(macOS)
import Foundation
import struct OpenClawKit.GatewayResponseError
import OpenClawProtocol
import SwiftUI

struct ChatSidebarArchiveRecovery: Identifiable {
    let id = UUID()
    let row: OpenClawChatSessionEntry
    let connection: OpenClawSessionMenuConnection
    let message: String
    let archivedAt: Int
    let lifecycleRevision: String?
}

struct ChatSidebarArchiveReceipt {
    let id = UUID()
    let rows: [OpenClawChatSessionEntry]
    let connection: OpenClawSessionMenuConnection
    let archiveUndoTokens: [String: String]
    var remaining: Duration = .seconds(6)
    var deadline: ContinuousClock.Instant? = ContinuousClock.now + .seconds(6)

    var message: String {
        self.rows.count == 1 ? String(localized: "Thread archived.") :
            String(format: String(localized: "%lld threads archived."), self.rows.count)
    }

    mutating func pause(_ paused: Bool, now: ContinuousClock.Instant) {
        // ui/src/lib/toast.ts:29,117: six seconds of unhovered, unfocused time.
        if paused, let deadline {
            self.remaining = max(.zero, now.duration(to: deadline))
            self.deadline = nil
        } else if !paused, deadline == nil {
            deadline = now + self.remaining
        }
    }
}

extension OpenClawSessionMenuConnection {
    func requestsArchiveUndo(for row: OpenClawChatSessionEntry) -> Bool {
        guard self.supportsArchiveUndo, row.incognito != true else { return false }
        // packages/session-url-contract/src/session-key.ts: partial rows can omit the incognito flag.
        let space = #"\p{Z}\t-\r\uFEFF"# // ECMAScript whitespace
        let surface = "(?:dashboard|subagent|internal-session-effects)"
        let pattern = #"^[\#(space)]*agent:[^:]+:\#(surface):incognito-[\#(space)]*[^:\#(space)][^:]*\z"#
        return row.key.lowercased().range(of: pattern, options: .regularExpression) == nil
    }
}

extension ChatSessionSidebarBatch {
    static func archiveIdentity(_ row: OpenClawChatSessionEntry) -> String {
        "\(OpenClawChatSessionSidebarData.identity(row))\u{0}\(row.sessionId ?? "")"
    }

    func isArchiving(_ row: OpenClawChatSessionEntry) -> Bool {
        pendingArchives[Self.archiveIdentity(row)] != nil
    }

    func beginArchive(_ row: OpenClawChatSessionEntry) -> UUID? {
        let key = Self.archiveIdentity(row)
        guard pendingArchives[key] == nil else { return nil }
        let token = UUID()
        pendingArchives[key] = token
        return token
    }

    func finishArchive(_ row: OpenClawChatSessionEntry, token: UUID) {
        let key = Self.archiveIdentity(row)
        // ui/src/lib/sessions/session-archive-state.ts:215 prevents retired completions
        // from clearing a newer same-target operation after reconnect.
        if pendingArchives[key] == token {
            pendingArchives[key] = nil
        }
    }

    @discardableResult
    func offerArchiveUndo(
        _ rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection,
        tokens: [String: String] = [:]) -> ChatSidebarArchiveReceipt?
    {
        // A personal pin flag never proves that this Archive cleared a shared pin.
        let accepted = connection.supportsArchiveUndo ? tokens.filter { !$0.value.isEmpty } : [:]
        let undoable = connection.supportsPersonalPins ? rows
            .filter { accepted[Self.archiveIdentity($0)] != nil } : rows
        guard !undoable.isEmpty, connection.isCurrent() else { return nil }
        archiveUndo = ChatSidebarArchiveReceipt(rows: undoable, connection: connection, archiveUndoTokens: accepted)
        return archiveUndo
    }

    func expireArchiveUndo(now: ContinuousClock.Instant = ContinuousClock.now) {
        if let deadline = archiveUndo?.deadline, deadline <= now {
            archiveUndo = nil
        }
    }

    func archive(
        _ row: OpenClawChatSessionEntry,
        mainKey: String,
        connection: OpenClawSessionMenuConnection,
        owner: OpenClawChatSessionSidebarData?,
        onArchived: () -> Void = {}) async -> ChatSidebarArchiveReceipt?
    {
        guard ChatSessionSidebarEligibility.canArchive(row, mainSessionKey: mainKey),
              let token = beginArchive(row) else { return nil }
        defer { self.finishArchive(row, token: token) }
        errors = [:]
        notices = []
        let requestUndo = connection.requestsArchiveUndo(for: row)
        guard let receipt = await patchArchive(
            row,
            archived: true,
            requestArchiveUndo: requestUndo,
            connection: connection,
            owner: owner) else { return nil }
        onArchived()
        let undoToken = requestUndo ? receipt.archiveUndoToken : nil
        let tokens = undoToken.map { [Self.archiveIdentity(row): $0] } ?? [:]
        return self.offerArchiveUndo([row], connection: connection, tokens: tokens)
    }

    private func patchArchive(
        _ row: OpenClawChatSessionEntry,
        archived: Bool,
        requestArchiveUndo: Bool = false,
        pinned: Bool? = nil,
        archiveUndoToken: String? = nil,
        recovery: ChatSidebarArchiveRecovery? = nil,
        connection: OpenClawSessionMenuConnection,
        owner: OpenClawChatSessionSidebarData?) async -> OpenClawChatSessionPatchReceipt?
    {
        guard ChatPayloadDecoding.trimmedNonEmptyString(row.sessionId) != nil,
              Self.allows(.archived(archived), rows: [row], connection: connection, method: "sessions.patch")
        else {
            notices = [String(localized: "These threads cannot be archived or restored. Refresh and try again.")]
            return nil
        }
        let token = owner?.beginMutation(target: row, field: .archived) {
            $0.archived = archived
            if !archived {
                $0.archivedAt = nil
            }
        }
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        do {
            var fields: [String: AnyCodable] = ["archived": .init(archived)]
            if let recovery {
                fields["expectedArchivedAt"] = .init(recovery.archivedAt)
                if let revision = recovery.lifecycleRevision {
                    fields["expectedLifecycleRevision"] = .init(revision)
                }
            }
            if requestArchiveUndo {
                fields["requestArchiveUndo"] = .init(true)
            }
            if let archiveUndoToken {
                fields["archiveUndoToken"] = .init(archiveUndoToken)
            }
            if let pinned {
                fields["pinned"] = .init(pinned)
            }
            let request = OpenClawChatGatewayRequests.sessionMenu("sessions.patch", session: row, fields: fields)
            let data = try await connection.request(.init(
                method: request.method, params: request.params, timeoutMs: archived ? 600_000 : 15000))
            var confirmed = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: data)
            confirmed.agentID = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
            guard confirmed.matches(row),
                  !connection.supportsArchiveUndo || (confirmed.entry.archivedAt != nil) == archived
            else { throw CocoaError(.coderReadCorrupt) }
            receipt = confirmed
            if pinned != nil {
                owner?.confirmFields(confirmed, target: row, fields: [.pinned])
            }
            return confirmed
        } catch {
            if connection.isCurrent() {
                errors[OpenClawChatSessionSidebarData.identity(row)] = error.localizedDescription
                if archiveUndoToken != nil, let response = error as? GatewayResponseError,
                   response.method == "sessions.patch", response.code == "INVALID_REQUEST",
                   response.detailsReason == "ARCHIVE_UNDO_REQUIRES_RESTORE",
                   let archivedAt = response.details["archivedAt"]?.value as? Int
                {
                    self.archiveRecoveries[Self.archiveIdentity(row)] = .init(
                        row: row, connection: connection, message: error.localizedDescription,
                        archivedAt: archivedAt, lifecycleRevision: response.details["lifecycleRevision"]?.stringValue)
                }
            }
            return nil
        }
    }

    func restoreArchivedSnapshot(_ displayed: ChatSidebarArchiveRecovery, owner: OpenClawChatSessionSidebarData?) async {
        let key = Self.archiveIdentity(displayed.row)
        guard archiveRecoveries[key]?.id == displayed.id else { return }
        archiveRecoveries.removeValue(forKey: key)
        guard displayed.connection.isCurrent() else { return }
        let errorKey = OpenClawChatSessionSidebarData.identity(displayed.row)
        if self.errors[errorKey] == displayed.message { self.errors[errorKey] = nil }
        // A separate user choice starts ordinary Restore; it never sends a pin or redeems the receipt.
        _ = await self.patchArchive(
            displayed.row, archived: false, recovery: displayed, connection: displayed.connection, owner: owner)
    }

    func takeArchiveUndo(id: UUID) -> ChatSidebarArchiveReceipt? {
        // An old click cannot consume a newer notification.
        guard let receipt = archiveUndo, receipt.id == id else { return nil }
        archiveUndo = nil
        return receipt
    }

    func undoArchive(_ receipt: ChatSidebarArchiveReceipt, owner: OpenClawChatSessionSidebarData?) async {
        let connection = receipt.connection
        guard connection.isCurrent() else {
            notices = [String(localized: "The Gateway changed. Archive Undo is no longer available.")]
            return
        }
        // ui/src/components/session-organizer-operations.runtime.ts:202,238: captured
        // identities outlive navigation; only successful restores regain their previous pins.
        _ = await ChatSessionBatchMutationRunner.run(
            keys: receipt.rows.map(Self.archiveIdentity))
        { @MainActor identity in
            guard let row = receipt.rows.first(where: { Self.archiveIdentity($0) == identity })
            else { return }
            let token = receipt.archiveUndoTokens[Self.archiveIdentity(row)]
            guard !connection.supportsPersonalPins || token != nil else { return }
            _ = await self.patchArchive(
                row,
                archived: false,
                pinned: !connection.supportsPersonalPins && row.pinned == true ? true : nil,
                archiveUndoToken: token,
                connection: connection,
                owner: owner)
        }
    }
}

extension ChatSessionSidebar {
    func isCurrentArchiveTarget(_ row: OpenClawChatSessionEntry) -> Bool {
        // An old archive ACK cannot navigate away from an admitted replacement.
        viewModel.sidebarData?.row(key: row.key, agentID: row.agentId)?.sessionId == row.sessionId &&
            isCurrentInteractionRow(row)
    }

    func archiveSidebarSession(_ session: OpenClawChatSessionEntry) async {
        if session.isArchived {
            await viewModel.restoreSession(session)
            return
        }
        var row = session
        row.agentId = OpenClawChatSessionKey.agentID(from: row.key) ??
            viewModel.sessionMutationTarget(key: row.key, agentID: row.agentId).agentID
        if viewModel.isAttachmentOwnerPinned,
           isCurrentInteractionRow(row)
        {
            batch.notices = [ChatSessionBatchValidationError.attachmentOwnerPinned.localizedDescription]
            return
        }
        guard !batch.isArchiving(row) else { return }
        guard let connection = menuActions.connection else {
            batch.notices = [String(localized: "The Gateway connection is not ready. Try again.")]
            return
        }
        _ = await batch.archive(
            row,
            mainKey: viewModel.selectedAgentMainSessionKey,
            connection: connection,
            owner: viewModel.sidebarData)
        {
            if connection.isCurrent(), self.isCurrentArchiveTarget(row) {
                self.viewModel.switchSession(to: self.viewModel.selectedAgentMainSessionKey)
            }
        }
        guard connection.isCurrent() else { return }
        viewModel.refreshSessions(limit: 200)
        viewModel.refreshSidebarData()
    }

    @ViewBuilder var archiveUndoNotice: some View {
        ChatSidebarArchiveNotice(batch: batch, undo: undoSidebarArchive)
        let recoveries = batch.archiveRecoveries.values.sorted { $0.row.key < $1.row.key }
        if let first = recoveries.first {
            HStack {
                if recoveries.count == 1 {
                    self.restoreSnapshotButton(first)
                } else {
                    Menu(String(localized: "Restore")) {
                        ForEach(recoveries) { self.restoreSnapshotButton($0) }
                    }
                }
                Button(String(localized: "Dismiss"), systemImage: "xmark") {
                    self.batch.archiveRecoveries.removeAll()
                }.labelStyle(.iconOnly)
            }.padding(8)
        }
    }

    private func restoreSnapshotButton(_ recovery: ChatSidebarArchiveRecovery) -> some View {
        let title = ChatSessionSidebarModel.sidebarDisplayName(for: recovery.row)
        return Button {
            Task { @MainActor in
                await self.batch.restoreArchivedSnapshot(recovery, owner: self.viewModel.sidebarData)
                self.viewModel.refreshSessions(limit: 200)
                self.viewModel.refreshSidebarData()
            }
        } label: {
            HStack {
                Text(String(localized: "Restore"))
                Text(verbatim: title)
            }
        }
    }

    func undoSidebarArchive(_ displayed: ChatSidebarArchiveReceipt) {
        guard let receipt = batch.takeArchiveUndo(id: displayed.id) else { return }
        Task { @MainActor in
            await self.batch.undoArchive(receipt, owner: self.viewModel.sidebarData)
            self.viewModel.refreshSessions(limit: 200)
            self.viewModel.refreshSidebarData()
        }
    }
}

private struct ChatSidebarArchiveNotice: View {
    @Bindable var batch: ChatSessionSidebarBatch
    let undo: (ChatSidebarArchiveReceipt) -> Void
    @State private var hovered = false
    @FocusState private var focus: Focus?
    private enum Focus { case undo, dismiss }

    var body: some View {
        if let receipt = batch.archiveUndo {
            HStack {
                Text(receipt.message)
                Spacer()
                Button(String(localized: "Undo")) { self.undo(receipt) }.focused(self.$focus, equals: .undo)
                Button(String(localized: "Dismiss"), systemImage: "xmark") { self.batch.archiveUndo = nil }
                    .labelStyle(.iconOnly).focused(self.$focus, equals: .dismiss)
            }
            .font(OpenClawChatTypography.caption).padding(8)
            .onHover { self.hovered = $0
                self.pause()
            }
            .onChange(of: self.focus) { _, _ in self.pause() }
            .onChange(of: receipt.id, initial: true) { _, _ in self.pause() }
            .onDisappear {
                // Removal need not emit a hover/focus exit.
                self.hovered = false
                self.focus = nil
                self.pause()
            }
            .task(id: receipt.deadline) {
                guard let deadline = receipt.deadline else { return }
                try? await Task.sleep(until: deadline, clock: .continuous)
                guard !Task.isCancelled else { return }
                self.batch.expireArchiveUndo()
            }
        }
    }

    private func pause() {
        self.batch.archiveUndo?.pause(self.hovered || self.focus != nil, now: ContinuousClock.now)
    }
}
#endif
