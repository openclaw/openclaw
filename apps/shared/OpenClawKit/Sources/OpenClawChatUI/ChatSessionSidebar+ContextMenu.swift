#if os(macOS)
import AppKit
import OpenClawProtocol
import SwiftUI

extension ChatSessionSidebar {
    var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return String(format: String(localized: "Delete “%@”?"), name)
    }

    var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
    }

    var isPresentingRenameAlert: Binding<Bool> {
        Binding(
            get: { self.sessionPendingRename != nil },
            set: { if !$0 { self.sessionPendingRename = nil } })
    }

    func contextMenu(for session: OpenClawChatSessionEntry, isChild: Bool) -> some View {
        var session = session
        session.agentId = OpenClawChatSessionKey.agentID(from: session.key) ??
            self.viewModel.sessionMutationTarget(key: session.key, agentID: session.agentId).agentID
        return ChatSessionSidebarRowMenu(
            viewModel: self.viewModel,
            session: session,
            isChild: isChild,
            groups: self.groups,
            actions: self.menuActions,
            inspect: { self.inspectedSession = session },
            rename: {
                self.renameText = session.label ?? session.displayName ?? ""
                self.sessionPendingRename = session
            },
            delete: { self.sessionPendingDeletion = session },
            present: { self.menuPresentation = $0 })
    }
}

@MainActor
private struct ChatSessionSidebarRowMenu: View {
    @Bindable var viewModel: OpenClawChatViewModel
    let session: OpenClawChatSessionEntry
    let isChild: Bool
    let groups: [OpenClawChatSessionGroup]
    let actions: ChatSessionSidebarActions
    let inspect: () -> Void
    let rename: () -> Void
    let delete: () -> Void
    let present: (ChatSessionIconPicker) -> Void

    var body: some View {
        Group {
            if let updatedAt = self.session.updatedAt, updatedAt.isFinite {
                Text(String(
                    format: String(localized: "Last active %@"),
                    Date(timeIntervalSince1970: updatedAt / 1000).formatted(.relative(
                        presentation: .named,
                        unitsStyle: .abbreviated))))
            }
            if ChatSessionSidebarEligibility.canPin(self.session, isChild: self.isChild) {
                self.button(
                    self.session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"),
                    "pin",
                    key: "p")
                {
                    self.viewModel.setSessionPinned(
                        key: self.session.key,
                        pinned: self.session.pinned != true,
                        agentID: self.session.agentId)
                }
            }
            self.button(String(localized: "Rename…"), "pencil", key: "r", action: self.rename)
            self.button(
                self.session.unread == true ? String(localized: "Mark Read") : String(localized: "Mark Unread"),
                "envelope",
                key: "u")
            {
                self.viewModel.setSessionUnread(
                    key: self.session.key,
                    unread: self.session.unread != true,
                    agentID: self.session.agentId)
            }
            if self.actions.connection?.hello.policy["hasMultipleSessionSharingIdentities"]?.value as? Bool == true,
               let hidden = self.session.hiddenFromInvolvingMe
            {
                self.button(
                    hidden ? String(localized: "Show in Involving me") : String(localized: "Hide from Involving me"),
                    "person.crop.circle")
                {
                    guard let id = self.session.sessionId else { return }
                    self.mutate("sessions.setInvolvement", [
                        "hidden": .init(!hidden),
                        "expectedSessionId": .init(id),
                    ])
                }
                .disabled(self.session.sessionId?.isEmpty != false ||
                    self.actions.connection?.allows("sessions.setInvolvement", scope: "operator.read") != true)
            }
            if ChatSessionSidebarEligibility.canArchive(
                self.session,
                mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
            {
                self.button(
                    self.session.isArchived ? String(localized: "Restore") : String(localized: "Archive"),
                    "archivebox",
                    key: "a")
                {
                    self.viewModel.setSessionArchived(self.session, archived: !self.session.isArchived)
                }
            }
            Divider()
            self.button(String(localized: "Icon & color…"), "paintpalette", key: "i") {
                if let connection = self.actions.connection { self.present(.init(
                    session: self.session,
                    connection: connection,
                    viewModel: self.viewModel)) }
            }.disabled(self.actions.connection?.allows("sessions.patch") != true)
            if ChatSessionSidebarActions.canMoveToGroup(
                self.session,
                mainKeys:
                self.viewModel.agentChoices.map { self.viewModel.mainSessionKey(forAgent: $0.id) } +
                    [self.viewModel.selectedAgentMainSessionKey]) { self.groupMenu }
            self.ownerMenu
            Divider()
            self.button(
                self.session.hasActiveRun == true ? String(localized: "Fork from last completed message") :
                    String(localized: "Fork conversation"),
                "arrow.triangle.branch",
                key: "f")
            {
                Task { await self.viewModel.forkSession(
                    key: self.session.key,
                    fromLastCompleted: self.session.hasActiveRun == true,
                    agentID: self.session.agentId) }
            }
            self.copyMenu
            self.openMenu
            Divider()
            Button(role: .destructive, action: self.delete) { Label("Delete…", systemImage: "trash") }
                .keyboardShortcut("d", modifiers: [])
                .disabled(!ChatSessionSidebarEligibility.canDelete(
                    [self.session], mainSessionKey: self.viewModel.selectedAgentMainSessionKey))
            self.button(String(localized: "Get Info…"), "info.circle", action: self.inspect)
        }
        .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    }

    private var groupMenu: some View {
        Menu("Move to group") {
            ForEach(Array(self.groups.enumerated()), id: \.element.name) { index, group in
                Button {
                    self.mutate("sessions.patch", ["category": .init(group.name)])
                } label: {
                    Label(group.name, systemImage: self.session.category == group.name ? "checkmark" : "folder")
                }.keyboardShortcut(self.groupShortcut(index))
            }
            if self.session.category?.isEmpty == false {
                Button(self.session.kind == "group" && self.session.pinned != true ?
                    String(localized: "Back to Groups") : String(localized: "Remove from group"))
                {
                    self.mutate("sessions.patch", ["category": .init(NSNull())])
                }.keyboardShortcut(self.groupShortcut(self.groups.count))
            }
            Button("New group…") {
                self.viewModel.promptSidebarGroup(session: self.session)
            }.keyboardShortcut(
                self.groupShortcut(self.groups.count + (self.session.category?.isEmpty == false ? 1 : 0)))
                .disabled(self.actions.connection?.allows("sessions.groups.put") != true)
        }.disabled(self.actions.connection?.allows("sessions.patch") != true)
    }

    private var ownerMenu: some View {
        Menu("Assign to…") {
            ForEach(self.actions.owners(session: self.session, agents: self.viewModel.agentChoices)) { owner in
                let checked = self.session.owner?.actor.type == owner.type && ChatSessionSidebarActions
                    .ownerID(self.session.owner?.actor) == owner.key
                Button {
                    self.mutate("sessions.assignOwner", ["owner": .init(["type": owner.type, "id": owner.key])])
                } label: {
                    HStack {
                        if let agent = self.viewModel.agentChoices
                            .first(where: { owner.type == "agent" && $0.id == owner.key })
                        {
                            ChatSidebarAgentAvatar(agent: agent, size: 20)
                        } else { Text(owner.label.prefix(2)).frame(width: 20, height: 20).background(
                            .quaternary,
                            in: Circle()) }
                        Text(owner.label)
                        if checked { Image(systemName: "checkmark") }
                    }
                }.disabled(checked)
            }
            if let error = self.actions.directoryError {
                Text(error)
                Button("Retry directory") {
                    self.actions.refresh()
                }.disabled(self.actions.loadingOwners)
            } else if self.actions.owners(session: self.session, agents: self.viewModel.agentChoices)
                .isEmpty { Text("Loading…") }
        }.disabled(self.actions.connection?.allows("sessions.assignOwner") != true)
    }

    private var copyMenu: some View {
        Menu("Copy") {
            Button("Session link") { self.copyLink(preview: false) }
                .disabled(self.actions.connection?.link(self.session, false) == nil)
            Button("Session preview link") { self.copyLink(preview: true) }
                .disabled(self.actions.connection?.link(self.session, true) == nil)
            Button("Markdown") {
                guard let connection = self.actions.connection else { return }
                self.viewModel.performSidebarAction(refresh: false) {
                    let markdown = try await self.viewModel.sidebarMarkdown(
                        session: self.session,
                        connection: connection)
                    guard connection.isCurrent() else { throw CancellationError() }
                    ChatPasteboard.copy(markdown)
                }
            }.disabled(self.actions.connection?.allows("chat.history", scope: "operator.sessions.read") != true)
            Button("Session ID") { if let id = self.session.sessionId { ChatPasteboard.copy(id) } }
                .disabled(self.session.sessionId?.isEmpty != false)
        }.keyboardShortcut("c", modifiers: [])
    }

    private var openMenu: some View {
        Menu("Open in") {
            Button("New window") { self.actions.connection?.openWindow(self.session) }
                .disabled(self.actions.connection?.isCurrent() != true)
            if let path = self.actions.worktreePath(for: self.session) {
                Divider()
                ForEach(
                    [("cursor", "Cursor"), ("vscode", "VS Code"), ("windsurf", "Windsurf"), ("zed", "Zed")],
                    id: \.0)
                { editor in
                    Button(editor.1) {
                        guard self.actions.connection?.isCurrent() == true,
                              let url = ChatSessionSidebarActions.editorURL(editor.0, path: path) else { return }
                        NSWorkspace.shared.open(url)
                    }
                }
            }
        }
    }

    private func groupShortcut(_ index: Int) -> KeyboardShortcut? {
        index < 9 ? KeyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: []) : nil
    }

    private func mutate(_ method: String, _ fields: [String: OpenClawProtocol.AnyCodable]) {
        guard let connection = self.actions.connection else { return }
        self.viewModel.performSidebarAction {
            try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
                method,
                session: self.session,
                fields: fields))
        }
    }

    private func copyLink(preview: Bool) {
        guard let connection = self.actions.connection, connection.isCurrent(),
              let url = connection.link(self.session, preview) else { return }
        ChatPasteboard.copy(url.absoluteString)
    }

    private func button(
        _ title: String,
        _ symbol: String,
        key: KeyEquivalent? = nil,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) { Label(title, systemImage: symbol) }.keyboardShortcut(key.map { KeyboardShortcut(
            $0,
            modifiers: []) })
    }
}
#endif
