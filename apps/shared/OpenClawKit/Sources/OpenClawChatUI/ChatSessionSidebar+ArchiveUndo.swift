#if os(macOS)
import Foundation
import OpenClawProtocol
import SwiftUI

struct ChatSidebarArchiveReceipt {
    let id = UUID()
    let rows: [OpenClawChatSessionEntry]
    let connection: OpenClawSessionMenuConnection
    let scope: UUID
    let captures: [String: OpenClawChatArchivePinOutcome]
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
        _ rows: [OpenClawChatSessionEntry],
        connection: OpenClawSessionMenuConnection,
        captures: [String: OpenClawChatArchivePinOutcome] = [:]) -> ChatSidebarArchiveReceipt?
    {
        guard !rows.isEmpty, connection.isCurrent() else { return nil }
        for warning in Set(captures.values.compactMap(\.undoWarning)) {
            self.notices.append(warning)
        }
        self.archiveUndo = ChatSidebarArchiveReceipt(
            rows: rows,
            connection: connection,
            scope: self.scope,
            captures: captures)
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
        guard let receipt = await self.patchArchive(row, archived: true, connection: connection, owner: owner)
        else { return nil }
        let occurrence = receipt.archivedAt.flatMap { Double($0) == receipt.entry.archivedAt ? $0 : nil }
        let capture = OpenClawChatArchivePinOutcome(
            archivePin: receipt.archivePin, archivedAt: occurrence, undo: receipt.archivePinUndo)
        return self.offerArchiveUndo(
            [row],
            connection: connection,
            captures: connection.supportsArchivePins ?
                [OpenClawChatSessionSidebarData.identity(row): capture] : [:])
    }

    private func patchArchive(
        _ row: OpenClawChatSessionEntry,
        archived: Bool,
        expectedArchivedAt: Int? = nil,
        connection: OpenClawSessionMenuConnection,
        owner: OpenClawChatSessionSidebarData?) async -> OpenClawChatSessionPatchReceipt?
    {
        guard ChatPayloadDecoding.trimmedNonEmptyString(row.sessionId) != nil,
              Self.allows(.archived(archived), rows: [row], connection: connection, method: "sessions.patch")
        else {
            self.notices = [String(localized: "These threads cannot be archived or restored. Refresh and try again.")]
            return nil
        }
        let scope = self.scope
        let token = owner?.beginMutation(target: row, field: .archived) {
            $0.archived = archived
            if !archived { $0.archivedAt = nil }
        }
        var receipt: OpenClawChatSessionPatchReceipt?
        defer { owner?.finishMutation(token, receipt: receipt) }
        do {
            // Only an old Gateway cleared the captured shared pin as part of archive.
            let restoreLegacyPin = !archived && row.pinned == true && !connection.supportsPersonalPins
            var fields: [String: AnyCodable] = ["archived": .init(archived)]
            if archived, connection.supportsArchivePins { fields["retirePersonalPin"] = .init(true) }
            if let expectedArchivedAt {
                fields["expectedArchived"] = .init(true)
                fields["expectedArchivedAt"] = .init(expectedArchivedAt)
            }
            if restoreLegacyPin { fields["pinned"] = .init(true) }
            let request = OpenClawChatGatewayRequests.sessionMenu("sessions.patch", session: row, fields: fields)
            let data = try await connection.request(.init(
                method: request.method, params: request.params, timeoutMs: archived ? 600_000 : 15000))
            var confirmed = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: data)
            confirmed.agentID = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
            guard self.scope == scope else { return nil }
            guard confirmed.matches(row),
                  (confirmed.entry.archivedAt != nil) == archived else { throw CocoaError(.coderReadCorrupt) }
            receipt = confirmed
            if restoreLegacyPin { owner?.confirmFields(confirmed, target: row, fields: [.pinned]) }
            return confirmed
        } catch {
            if self.scope == scope, connection.isCurrent() {
                self.errors[OpenClawChatSessionSidebarData.identity(row)] = error.localizedDescription
            }
            return nil
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
        guard self.scope == receipt.scope else { return }
        guard connection.isCurrent() else {
            self.notices = [String(localized: "The Gateway changed. Archive Undo is no longer available.")]
            return
        }
        let rows = receipt.rows.filter { row in
            !connection.supportsArchivePins || receipt.captures[OpenClawChatSessionSidebarData.identity(row)]?
                .archivedAt != nil
        }
        let keys = rows.map(OpenClawChatSessionSidebarData.identity)
        let restored = await ChatSessionBatchMutationRunner.run(keys: keys) { @MainActor identity in
            guard self.scope == receipt.scope, connection.isCurrent(),
                  let row = rows.first(where: { OpenClawChatSessionSidebarData.identity($0) == identity }),
                  await self
                      .patchArchive(
                          row,
                          archived: false,
                          expectedArchivedAt: receipt.captures[identity]?.archivedAt,
                          connection: connection,
                          owner: owner) != nil
            else { throw CancellationError() }
        }
        // Each archive chunk compared a different layout. Undo the last removal first; never rebase a witness.
        let successes = Set(restored.succeededKeys)
        var tokens: [String] = []
        var groups: [String: [OpenClawChatSessionEntry]] = [:]
        for row in rows {
            let identity = OpenClawChatSessionSidebarData.identity(row)
            guard successes.contains(identity), let witness = receipt.captures[identity]?.undo else { continue }
            if groups[witness] == nil { tokens.append(witness) }
            groups[witness, default: []].append(row)
        }
        for witness in tokens.reversed() {
            guard self.scope == receipt.scope, connection.isCurrent(), let group = groups[witness] else { return }
            var fields: [String: AnyCodable] = ["pinned": .init(true), "archivePinUndo": .init(witness)]
            if group.count == 1, let row = group.first {
                fields["expectedArchived"] = .init(false)
                do {
                    let request = OpenClawChatGatewayRequests.sessionMenu(
                        "sessions.patch",
                        session: row,
                        fields: fields)
                    let data = try await connection.request(request)
                    var confirmed = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: data)
                    confirmed.agentID = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
                    guard self.scope == receipt.scope else { return }
                    guard confirmed.matches(row),
                          confirmed.entry.pinned == true else { throw CocoaError(.coderReadCorrupt) }
                    owner?.confirmFields(confirmed, target: row, fields: [.pinned])
                } catch {
                    guard self.scope == receipt.scope, connection.isCurrent() else { return }
                    self.notices
                        .append(
                            String(localized: "Thread restored. Could not confirm restoration of its personal pin.") +
                                " " + error.localizedDescription)
                }
            } else {
                _ = await self.patch(group, fields: fields, connection: connection)
            }
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
                    .disabled(receipt.connection.supportsArchivePins && !receipt.captures.values
                        .contains { $0.archivedAt != nil })
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
