#if os(macOS)
import AppKit
import OpenClawProtocol
import SwiftUI

extension ChatSessionSidebar {
    var selectedBatchRows: [OpenClawChatSessionEntry] {
        self.visibleInteractionRows.filter { self.batch.selection.keys.contains(self.interactionIdentity($0)) }
    }

    private var visibleInteractionRows: [OpenClawChatSessionEntry] {
        ChatSidebarSelection.visibleRoots(
            in: self.rosterSections(observedOrder: self.observedOrder),
            searching: !self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isCollapsed: self.isGroupCollapsed).map(self.batchTarget)
    }

    func interactionIdentity(_ row: OpenClawChatSessionEntry) -> String {
        OpenClawChatSessionSidebarData.identity(self.batchTarget(row))
    }

    private var renderedInteractionRows: [OpenClawChatSessionEntry] {
        self.rosterSections(observedOrder: self.observedOrder).flatMap(\.nodes).flatMap(\.previewSessions)
            .map(self.batchTarget)
    }

    private func isCurrentInteractionRow(_ row: OpenClawChatSessionEntry) -> Bool {
        self.viewModel.matchesCurrentSessionKey(
            incoming: row.key,
            agentId: row.agentId,
            current: self.viewModel.sessionKey)
    }

    private func batchTarget(_ row: OpenClawChatSessionEntry) -> OpenClawChatSessionEntry {
        var row = row
        row.agentId = OpenClawChatSessionKey.agentID(from: row.key) ??
            self.viewModel.sessionMutationTarget(key: row.key, agentID: row.agentId).agentID
        return row
    }

    var batchSelectionBinding: Binding<Set<String>> {
        Binding(get: {
            if self.batch.selection.active { return self.batch.selection.keys }
            let selected = self.renderedInteractionRows.first(where: self.isCurrentInteractionRow)
            return Set([selected.map(self.interactionIdentity)].compactMap(\.self))
        }, set: { proposed in
            guard !self.batch.running else { return }
            let roots = Set(self.visibleInteractionRows.map(self.interactionIdentity))
            // ui/src/components/app-sidebar-session-navigation.ts:481; macOS List owns
            // Cmd-toggle and Shift ranges. Filter child tags out of every batch selection.
            let multiple = !NSEvent.modifierFlags.intersection([.command, .shift]).isEmpty || proposed.count > 1
            if let identity = self.batch.selection.update(proposed, roots: roots, multiple: multiple),
               let row = self.renderedInteractionRows.first(where: { self.interactionIdentity($0) == identity })
            {
                Task { @MainActor in self.viewModel.switchSession(to: row.key, agentID: row.agentId) }
            }
        })
    }

    var batchBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            if self.batch.selection.active {
                HStack {
                    Text(String(format: String(localized: "%lld selected"), self.selectedBatchRows.count))
                    Spacer()
                    Menu(String(localized: "Actions")) { self.batchMenu }
                        .disabled(self.batch.running || self.selectedBatchRows.isEmpty)
                    Button(String(localized: "Done")) { self.batch.selection = .init() }
                        .disabled(self.batch.running)
                }
                if self.batch.running { ProgressView().controlSize(.small) }
            }
            if !self.batch.errors.isEmpty {
                Text(String(localized: "Some thread operations failed. See the affected rows and try again."))
                    .foregroundStyle(.red)
            }
            ForEach(self.batch.notices, id: \.self) { Text(verbatim: $0) }
        }
        .font(OpenClawChatTypography.caption)
        .padding(self.batch.selection.active || !self.batch.errors.isEmpty ? 8 : 0)
    }

    @ViewBuilder var batchMenu: some View {
        let rows = self.selectedBatchRows
        let unread = rows.allSatisfy { $0.unread == true }
        let archived = rows.allSatisfy(\.isArchived)
        Button(unread ? String(localized: "Mark Read") : String(localized: "Mark Unread")) {
            self.runSidebarBatch(.unread(!unread), rows: rows)
        }.disabled(self.batch.connection?.allows("sessions.patchMany") != true)
        Menu(String(localized: "Move to group")) {
            ForEach(self.groups) { group in
                Button(group.name) { self.runSidebarBatch(.category(group.name), rows: rows) }
            }
            Button(String(localized: "Remove from group")) { self.runSidebarBatch(.category(nil), rows: rows) }
        }.disabled(self.batch.connection?.allows("sessions.patchMany") != true)
        Button(archived ? String(localized: "Restore") : String(localized: "Archive")) {
            self.runSidebarBatch(.archived(!archived), rows: rows)
        }.disabled(!rows.allSatisfy { ChatSessionSidebarEligibility.canArchive(
            $0,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey) } ||
            self.batch.connection
            .map { ChatSessionSidebarBatch.allows(.archived(!archived), rows: rows, connection: $0) } != true)
        Divider()
        Button(String(localized: "Delete…"), role: .destructive) { self.batch.pendingDelete = rows }
            .disabled(!ChatSessionSidebarEligibility.canDelete(
                rows,
                mainSessionKey: self.viewModel.selectedAgentMainSessionKey) ||
                self.batch.connection?
                .allows("sessions.delete", scope: archived ? "operator.write" : "operator.admin") != true)
    }

    func loadInteractionGroups() async throws -> [OpenClawChatSessionGroup] {
        guard let acquire = self.menuCommands?.sessionMenuConnection else { throw CancellationError() }
        let connection = try await acquire()
        try Task.checkCancellation()
        self.batch.connection = connection
        let result: ChatSessionSidebarBatch.Groups = try await connection.read("sessions.groups.list")
        return result.groups
    }

    func runSidebarBatch(_ action: ChatSessionSidebarBatch.Action, rows: [OpenClawChatSessionEntry]) {
        let owner = self.viewModel.sidebarData
        let mainKey = self.viewModel.selectedAgentMainSessionKey
        if action == .delete || action == .archived(true), self.viewModel.isAttachmentOwnerPinned,
           let target = rows.first(where: self.isCurrentInteractionRow)
        {
            self.batch.errors[self.interactionIdentity(target)] = ChatSessionBatchValidationError.attachmentOwnerPinned
                .localizedDescription
            return
        }
        guard !self.batch.running, let connection = self.batch.connection else { return }
        let scope = self.batch.scope
        self.batch.pendingDelete = []
        self.batch.running = true
        self.batch.notices = []
        Task { @MainActor in
            defer { if scope == self.batch.scope { self.batch.running = false } }
            guard scope == self.batch.scope else { return }
            let successful = await self.batch.run(action, rows: rows, mainKey: mainKey, connection: connection)
            guard scope == self.batch.scope, connection.isCurrent() else { return }
            if action == .delete { for row in successful {
                owner?.remove(row)
            } }
            if action == .delete || action == .archived(true),
               successful.contains(where: self.isCurrentInteractionRow)
            { self.viewModel.switchSession(to: mainKey) }
            if action == .delete || action ==
                .archived(true) { self.batch.selection.keys.subtract(successful.map(self.interactionIdentity)) }
            self.viewModel.refreshSessions(limit: 200)
            self.viewModel.refreshSidebarData()
        }
    }

    func interactionRow(_ content: some View, session: OpenClawChatSessionEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            content
            if let error = self.batch.errors[self.interactionIdentity(session)] {
                Text(verbatim: error).font(OpenClawChatTypography.caption).foregroundStyle(.red)
            }
        }
    }
}
#endif
