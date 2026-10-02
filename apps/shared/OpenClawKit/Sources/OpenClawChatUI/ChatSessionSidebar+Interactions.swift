#if os(macOS)
import AppKit
import OpenClawProtocol
import SwiftUI
import UniformTypeIdentifiers

struct ChatSidebarDrag: Codable, Transferable {
    let scope: UUID
    let key: String
    var sessionID: String?
    var section = false

    static var transferRepresentation: some TransferRepresentation {
        // ui/src/lib/sessions/drag.ts:1 rejects ordinary text/file drags.
        CodableRepresentation(contentType: UTType(exportedAs: "ai.openclaw.sidebar-item"))
    }
}

extension ChatSessionSidebar {
    func interactionSections(now: Date = .now) -> [ChatSessionSidebarModel.Section] {
        var sections = self.rosterSections(now: now, observedOrder: self.observedOrder)
        let positions = Dictionary(
            self.batch.sidebarEntries.enumerated().map { ($0.element, $0.offset) },
            uniquingKeysWith: min)
        sections = sections.map { section in
            guard section.id == "pinned" else { return section }
            let nodes = section.nodes.enumerated().sorted {
                (positions["session:\($0.element.id)"] ?? Int.max, $0.offset) <
                    (positions["session:\($1.element.id)"] ?? Int.max, $1.offset)
            }.map(\.element)
            return .init(id: section.id, title: section.title, nodes: nodes)
        }
        // Preserve the roster owner's grouping and empty-group filters; only Pages needs an empty drop target.
        if self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !sections.contains(where: { $0.id == "pinned" })
        {
            sections.insert(.init(id: "pinned", title: String(localized: "Pinned"), nodes: []), at: 0)
        }
        return sections
    }

    var selectedBatchRows: [OpenClawChatSessionEntry] {
        self.visibleInteractionRows.filter { self.batch.selection.keys.contains(self.interactionIdentity($0)) }
    }

    private var visibleInteractionRows: [OpenClawChatSessionEntry] {
        let sections = self.interactionSections().map { section in
            guard self.showsAgentRoster,
                  let agent = self.viewModel.agentChoices.first(where: { section.id == "agent:\($0.id):recent" })
            else { return section }
            return ChatSessionSidebarModel.Section(
                id: section.id, title: section.title, nodes: self.visibleAgentRows(section.nodes, agentID: agent.id))
        }
        return ChatSidebarSelection.visibleRoots(
            in: sections,
            searching: !self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            isCollapsed: self.isGroupCollapsed).map(self.batchTarget)
    }

    func interactionIdentity(_ row: OpenClawChatSessionEntry) -> String {
        OpenClawChatSessionSidebarData.identity(self.batchTarget(row))
    }

    private var renderedInteractionRows: [OpenClawChatSessionEntry] {
        self.interactionSections().flatMap(\.nodes).flatMap(\.previewSessions).map(self.batchTarget)
    }

    func isCurrentInteractionRow(_ row: OpenClawChatSessionEntry) -> Bool {
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
            guard !self.batch.busy else { return }
            let roots = Set(self.visibleInteractionRows.map(self.interactionIdentity))
            // ui/src/components/app-sidebar-session-navigation.ts:481; macOS List owns
            // Cmd-toggle and Shift ranges. Filter child tags out of every batch selection.
            let multiple = !NSEvent.modifierFlags.isDisjoint(with: [.command, .shift]) || proposed.count > 1
            if let identity = self.batch.selection.update(proposed, roots: roots, multiple: multiple),
               let row = self.renderedInteractionRows.first(where: { self.interactionIdentity($0) == identity })
            {
                Self.selectionBinding(model: self.viewModel).wrappedValue = .init(
                    sessionKey: row.key, agentID: row.agentId)
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
                        .disabled(self.batch.busy || self.selectedBatchRows.isEmpty)
                    Button(String(localized: "Done")) { self.batch.selection = .init() }
                        .disabled(self.batch.busy)
                }
            }
            if !self.batch.pendingArchives.isEmpty {
                ProgressView(String(localized: "Archiving…")).controlSize(.small)
            } else if self.batch.busy {
                ProgressView().controlSize(.small)
            }
            if !self.batch.errors.isEmpty {
                Text(String(localized: "Some thread operations failed. See the affected rows and try again."))
                    .foregroundStyle(OpenClawChatTheme.danger)
            }
            ForEach(Array(Set(self.batch.notices + Array(self.batch.errors.values))).sorted(), id: \.self) {
                Text(verbatim: $0)
            }
        }
        .font(OpenClawChatTypography.caption)
        .padding(self.batch.selection.active || !self.batch.errors.isEmpty || self.batch.busy || !self.batch
            .pendingArchives.isEmpty ? 8 : 0)
    }

    @ViewBuilder var batchMenu: some View {
        let rows = self.selectedBatchRows
        let unread = rows.allSatisfy { $0.unread == true }
        let archived = rows.allSatisfy(\.isArchived)
        Button(unread ? String(localized: "Mark Read") : String(localized: "Mark Unread")) {
            self.runSidebarBatch(.unread(!unread), rows: rows)
        }.disabled(self.menuActions.connection?.allows("sessions.patchMany") != true)
        Menu(String(localized: "Move to group")) {
            ForEach(self.groups) { group in
                Button(group.name) { self.runSidebarBatch(.category(group.name), rows: rows) }
            }
            Button(String(localized: "Remove from group")) { self.runSidebarBatch(.category(nil), rows: rows) }
            Divider()
            Button(String(localized: "New group…")) { self.promptSidebarBatchGroup(rows: rows) }
                .disabled(self.menuActions.connection?.allows("sessions.groups.put") != true)
        }.disabled(self.menuActions.connection?.allows("sessions.patchMany") != true)
        Button(archived ? String(localized: "Restore") : String(localized: "Archive")) {
            self.runSidebarBatch(.archived(!archived), rows: rows)
        }.disabled(!rows.allSatisfy { ChatSessionSidebarEligibility.canArchive(
            $0,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey) } ||
            self.menuActions.connection
            .map { ChatSessionSidebarBatch.allows(.archived(!archived), rows: rows, connection: $0) } != true)
        Divider()
        Button(String(localized: "Delete…"), role: .destructive) { self.batch.pendingDelete = rows }
            .disabled(!ChatSessionSidebarEligibility.canDelete(
                rows,
                mainSessionKey: self.viewModel.selectedAgentMainSessionKey) ||
                self.menuActions.connection?
                .allows("sessions.delete", scope: archived ? "operator.write" : "operator.admin") != true)
    }

    private func promptSidebarBatchGroup(rows: [OpenClawChatSessionEntry]) {
        guard !self.batch.busy, let connection = self.menuActions.connection else { return }
        let scope = self.batch.scope
        let alert = NSAlert()
        alert.messageText = String(localized: "New group")
        let field = NSTextField(string: "")
        field.frame.size = NSSize(width: 260, height: 24)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.addButton(withTitle: String(localized: "Create group"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        guard alert.runModal() == .alertFirstButtonReturn,
              scope == self.batch.scope, connection.isCurrent() else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        self.runSidebarBatch(.newGroup(name), rows: rows)
    }

    func watchPinOrder() async {
        var loaded = false
        for await event in self.viewModel.transport.events() {
            switch event {
            case .health(true) where !loaded, .modelSelectionChanged, .reconnected, .routeChanged, .seqGap:
                let scope = self.batch.scope
                do {
                    guard let connection = self.menuActions.connection else { return }
                    try await self.batch.refreshPins(connection)
                    loaded = true
                } catch { if !Task.isCancelled,
                             scope == self.batch.scope { self.batch.notices = [error.localizedDescription] }
                }
            default: break
            }
        }
    }

    func interact<T>(
        refresh: Bool = true,
        refreshAcrossQueries: Bool = false,
        _ operation: @escaping @MainActor (OpenClawSessionMenuConnection) async throws -> T,
        apply: @escaping @MainActor (T) -> Void)
    {
        guard !self.batch.busy, let connection = self.menuActions.connection else { return }
        let scope = self.batch.scope
        self.batch.running = true
        self.batch.notices = []
        Task { @MainActor in
            defer { if scope == self.batch.scope { self.batch.running = false } }
            do {
                guard scope == self.batch.scope else { return }
                let result = try await operation(connection)
                guard connection.isCurrent() else { return }
                let currentQuery = scope == self.batch.scope
                if currentQuery { apply(result) }
                if refresh, currentQuery || refreshAcrossQueries {
                    self.viewModel.refreshSessions(limit: 200)
                    self.viewModel.refreshSidebarData()
                }
            } catch { if scope == self.batch.scope { self.batch.notices = [error.localizedDescription] } }
        }
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
        self.batch.pendingDelete = []
        self.interact(refreshAcrossQueries: action == .archived(true)) { connection in
            let successful = await self.batch.run(action, rows: rows, mainKey: mainKey, connection: connection)
            if action == .archived(true), successful.contains(where: self.isCurrentArchiveTarget) {
                self.viewModel.switchSession(to: self.viewModel.selectedAgentMainSessionKey)
            }
            return successful
        } apply: { successful in
            if case .newGroup = action { self.groupRefreshNonce += 1 }
            if action == .delete { for row in successful {
                owner?.remove(row)
            } }
            if action == .delete,
               successful.contains(where: self.isCurrentInteractionRow)
            { self.viewModel.switchSession(to: mainKey) }
            if action == .delete || action ==
                .archived(true) { self.batch.selection.keys.subtract(successful.map(self.interactionIdentity)) }
        }
    }

    func interactionRow(_ content: some View, session: OpenClawChatSessionEntry, isChild: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            // ui/src/components/app-sidebar-session-row-render.ts:417 gates all root drags,
            // including pins rendered through the same row owner, on group-write access.
            if !isChild, self.menuActions.connection?.allows("sessions.groups.put") == true {
                content.draggable(ChatSidebarDrag(
                    scope: self.batch.scope,
                    key: self.interactionIdentity(session),
                    sessionID: session.sessionId))
            } else { content }
            if let error = self.batch.errors[self.interactionIdentity(session)] {
                Text(verbatim: error).font(OpenClawChatTypography.caption).foregroundStyle(OpenClawChatTheme.danger)
            }
        }
        .modifier(ChatSidebarSectionInteraction(
            sidebar: self,
            section: !isChild && session.pinned == true ? "pinned" : "",
            draggable: false,
            pinTarget: session))
    }

    func dropInteraction(
        _ item: ChatSidebarDrag,
        section: String,
        after: Bool,
        pinTarget: OpenClawChatSessionEntry? = nil) -> Bool
    {
        guard item.scope == self.batch.scope, !self.batch.busy,
              let connection = self.menuActions.connection,
              connection.allows("sessions.groups.put") else { return false }
        if item.section {
            guard ChatSessionSidebarBatch.canReorderSection(section) else { return false }
            self.interact(
                refresh: false)
            { connection in try await self.batch.moveSection(
                item.key,
                to: section,
                after: after,
                connection: connection) } apply: { result in
                self.groups = result.groups
                self.sectionOrder = result.sectionOrder ?? []
            }
            return true
        }
        guard section != "recent" || self.sessionGrouping == .category else { return false }
        guard let held = self.visibleInteractionRows.first(where: { self.interactionIdentity($0) == item.key }),
              held.sessionId == item.sessionID else { return false }
        let row = self.batchTarget(held)
        let scope = self.batch.scope
        let patch: [String: AnyCodable]?
        switch ChatSessionSidebarBatch.drop(row, section: section, target: pinTarget.map(self.batchTarget)) {
        case .selfDrop?: return true
        case let .mutation(fields)?: patch = fields
        case nil: return false
        }
        if section == "pinned", !connection.allows("config.patch", scope: "operator.admin") { return false }
        let keys = self.visibleInteractionRows.filter { $0.pinned == true }.map(\.key) + [row.key]
        let owner = self.viewModel.sidebarData
        self.interact(refresh: patch != nil) { connection in
            self.batch.errors = [:]
            if let patch {
                let data = try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
                    "sessions.patch",
                    session: row,
                    fields: patch))
                var receipt = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: data)
                receipt.agentID = OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId
                guard scope == self.batch.scope else { throw CancellationError() }
                // Pin state is already committed even if persisting its subsequent placement fails.
                let fields = [OpenClawChatSessionSidebarData.Field.category, .pinned]
                    .filter { patch[$0.rawValue] != nil }
                owner?.confirmFields(receipt, target: row, fields: fields)
            }
            if section == "pinned" {
                guard scope == self.batch.scope else { throw CancellationError() }
                try await self.batch.movePin(
                    keys: keys,
                    key: row.key,
                    target: pinTarget?.key,
                    after: after,
                    connection: connection)
            }
        } apply: { _ in }
        return true
    }
}

struct ChatSidebarSectionInteraction: ViewModifier {
    let sidebar: ChatSessionSidebar
    let section: String
    var draggable = true
    var pinTarget: OpenClawChatSessionEntry?
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        if self.section.isEmpty {
            content
        } else {
            Group {
                if self.draggable, ChatSessionSidebarBatch.canReorderSection(self.section),
                   self.sidebar.menuActions.connection?.allows("sessions.groups.put") == true
                {
                    content.draggable(ChatSidebarDrag(
                        scope: self.sidebar.batch.scope,
                        key: self.section,
                        section: true))
                } else {
                    content
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { self.height = $0 }
            .dropDestination(for: ChatSidebarDrag.self) { items, location in
                guard items.count == 1, let item = items.first else { return false }
                return self.sidebar.dropInteraction(
                    item,
                    section: self.section,
                    after: location.y > self.height / 2,
                    pinTarget: self.pinTarget)
            }
        }
    }
}
#endif
