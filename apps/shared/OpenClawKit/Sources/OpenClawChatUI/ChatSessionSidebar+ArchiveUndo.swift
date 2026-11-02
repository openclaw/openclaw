#if os(macOS)
import Foundation
import OpenClawProtocol
import SwiftUI

struct ChatSidebarArchiveReceipt {
    let id = UUID()
    let rows: [OpenClawChatSessionEntry]
    let connection: OpenClawSessionMenuConnection
    var remaining: Duration = .seconds(6)
    var deadline: ContinuousClock.Instant? = ContinuousClock.now + .seconds(6)

    var message: String {
        self.rows.count == 1 ? String(localized: "Thread archived.") :
            String(format: String(localized: "%lld threads archived."), self.rows.count)
    }

    mutating func pause(_ paused: Bool, now: ContinuousClock.Instant) {
        // ui/src/lib/toast.ts:29,117: six seconds of unhovered, unfocused time.
        if paused, let deadline = self.deadline {
            self.remaining = max(.zero, now.duration(to: deadline))
            self.deadline = nil
        } else if !paused, self.deadline == nil {
            self.deadline = now + self.remaining
        }
    }
}

extension ChatSessionSidebarBatch {
    private static func archiveIdentity(_ row: OpenClawChatSessionEntry) -> String {
        "\(OpenClawChatSessionSidebarData.identity(row))\u{0}\(row.sessionId ?? "")"
    }

    func isArchiving(_ row: OpenClawChatSessionEntry) -> Bool {
        self.pendingArchives[Self.archiveIdentity(row)] != nil
    }

    func beginArchive(_ row: OpenClawChatSessionEntry) -> UUID? {
        let key = Self.archiveIdentity(row)
        guard self.pendingArchives[key] == nil else { return nil }
        let token = UUID()
        self.pendingArchives[key] = token
        return token
    }

    func finishArchive(_ row: OpenClawChatSessionEntry, token: UUID) {
        let key = Self.archiveIdentity(row)
        // ui/src/lib/sessions/session-archive-state.ts:215 prevents retired completions
        // from clearing a newer same-target operation after reconnect.
        if self.pendingArchives[key] == token { self.pendingArchives[key] = nil }
    }

    @discardableResult
    func offerArchiveUndo(
        _ rows: [OpenClawChatSessionEntry], connection: OpenClawSessionMenuConnection) -> ChatSidebarArchiveReceipt?
    {
        guard !rows.isEmpty, connection.isCurrent() else { return nil }
        self.archiveUndo = ChatSidebarArchiveReceipt(rows: rows, connection: connection)
        return self.archiveUndo
    }

    func expireArchiveUndo(now: ContinuousClock.Instant = ContinuousClock.now) {
        if let deadline = self.archiveUndo?.deadline, deadline <= now { self.archiveUndo = nil }
    }

    func archive(
        _ row: OpenClawChatSessionEntry,
        mainKey: String,
        connection: OpenClawSessionMenuConnection,
        owner: OpenClawChatSessionSidebarData?) async -> ChatSidebarArchiveReceipt?
    {
        guard ChatSessionSidebarEligibility.canArchive(row, mainSessionKey: mainKey),
              let token = self.beginArchive(row) else { return nil }
        defer { self.finishArchive(row, token: token) }
        self.errors = [:]
        self.notices = []
        guard await self.patchArchive(
            row,
            archived: true,
            connection: connection,
            owner: owner) else { return nil }
        return self.offerArchiveUndo([row], connection: connection)
    }

    private func patchArchive(
        _ row: OpenClawChatSessionEntry,
        archived: Bool,
        pinned: Bool? = nil,
        connection: OpenClawSessionMenuConnection,
        owner: OpenClawChatSessionSidebarData?) async -> Bool
    {
        guard ChatPayloadDecoding.trimmedNonEmptyString(row.sessionId) != nil,
              Self.allows(.archived(archived), rows: [row], connection: connection, method: "sessions.patch")
        else {
            self.notices = [String(localized: "These threads cannot be archived or restored. Refresh and try again.")]
            return false
        }
        let token = owner?.beginMutation(target: row, field: .archived) {
            $0.archived = archived
            if !archived { $0.archivedAt = nil }
        }
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        do {
            var fields: [String: AnyCodable] = ["archived": .init(archived)]
            if let pinned { fields["pinned"] = .init(pinned) }
            let request = OpenClawChatGatewayRequests.sessionMenu("sessions.patch", session: row, fields: fields)
            let data = try await connection.request(.init(
                method: request.method, params: request.params, timeoutMs: archived ? 600_000 : 15000))
            var confirmed = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: data)
            confirmed.agentID = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
            guard confirmed.matches(row) else { throw CocoaError(.coderReadCorrupt) }
            receipt = confirmed
            if pinned != nil { owner?.confirmFields(confirmed, target: row, fields: [.pinned]) }
            return true
        } catch {
            if connection.isCurrent() {
                self.errors[OpenClawChatSessionSidebarData.identity(row)] = error.localizedDescription
            }
            return false
        }
    }

    func takeArchiveUndo(id: UUID) -> ChatSidebarArchiveReceipt? {
        // An old click cannot consume a newer notification.
        guard let receipt = self.archiveUndo, receipt.id == id else { return nil }
        self.archiveUndo = nil
        return receipt
    }

    func undoArchive(_ receipt: ChatSidebarArchiveReceipt, owner: OpenClawChatSessionSidebarData?) async {
        let connection = receipt.connection
        guard connection.isCurrent() else {
            self.notices = [String(localized: "The Gateway changed. Archive Undo is no longer available.")]
            return
        }
        // ui/src/components/session-organizer-operations.runtime.ts:202,238: captured
        // identities outlive navigation; only successful restores regain their previous pins.
        _ = await ChatSessionBatchMutationRunner.run(
            keys: receipt.rows.map(OpenClawChatSessionSidebarData.identity))
        { @MainActor identity in
            guard let row = receipt.rows.first(where: { OpenClawChatSessionSidebarData.identity($0) == identity })
            else { return }
            // Each ACK carries authoritative fields; restore and repin commit together even in a batch.
            _ = await self.patchArchive(
                row,
                archived: false,
                pinned: row.pinned == true ? true : nil,
                connection: connection,
                owner: owner)
        }
    }
}

extension ChatSessionSidebar {
    func isCurrentArchiveTarget(_ row: OpenClawChatSessionEntry) -> Bool {
        // An old archive ACK cannot navigate away from an admitted replacement.
        self.viewModel.sidebarData?.row(key: row.key, agentID: row.agentId)?.sessionId == row.sessionId &&
            self.isCurrentInteractionRow(row)
    }

    func archiveSidebarSession(_ session: OpenClawChatSessionEntry) async {
        if session.isArchived {
            await self.viewModel.restoreSession(session)
            return
        }
        var row = session
        row.agentId = OpenClawChatSessionKey.agentID(from: row.key) ??
            self.viewModel.sessionMutationTarget(key: row.key, agentID: row.agentId).agentID
        if self.viewModel.isAttachmentOwnerPinned,
           self.isCurrentInteractionRow(row)
        {
            self.batch.notices = [ChatSessionBatchValidationError.attachmentOwnerPinned.localizedDescription]
            return
        }
        guard !self.batch.isArchiving(row) else { return }
        guard let connection = self.menuActions.connection else {
            self.batch.notices = [String(localized: "The Gateway connection is not ready. Try again.")]
            return
        }
        let receipt = await self.batch.archive(
            row,
            mainKey: self.viewModel.selectedAgentMainSessionKey,
            connection: connection,
            owner: self.viewModel.sidebarData)
        guard connection.isCurrent() else { return }
        if receipt != nil, self.isCurrentArchiveTarget(row) {
            self.viewModel.switchSession(to: self.viewModel.selectedAgentMainSessionKey)
        }
        self.viewModel.refreshSessions(limit: 200)
        self.viewModel.refreshSidebarData()
    }

    var archiveUndoNotice: some View {
        ChatSidebarArchiveNotice(batch: self.batch, undo: self.undoSidebarArchive)
    }

    func undoSidebarArchive(_ displayed: ChatSidebarArchiveReceipt) {
        guard let receipt = self.batch.takeArchiveUndo(id: displayed.id) else { return }
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
        if let receipt = self.batch.archiveUndo {
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
