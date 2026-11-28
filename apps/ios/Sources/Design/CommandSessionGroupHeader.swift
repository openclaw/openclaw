import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

/// A user-made group's header: the same fold control as Needs you, Working, Pinned and Recent, with the group's
/// actions (new session, defaults, rename, reorder, delete) on a long press.
struct CommandSessionGroupHeader<Accessory: View>: View {
    @Environment(NodeAppModel.self) private var appModel
    let name: String
    let sessions: [OpenClawChatSessionEntry]
    let refresh: () async -> Void
    let openSession: (String) -> Void
    @ViewBuilder let accessory: () -> Accessory
    @State private var editor: GroupEditor?
    @State private var draft = ""
    @State private var confirmsDelete = false
    /// A change this header asked the Gateway for is still pending; a group delete can take several seconds.
    @State private var busy = false
    @State private var defaultsModel: ChatSessionGroupDefaultsModel?

    private enum GroupEditor: Equatable { case rename, create }
    private var groups: SessionGroupModel {
        self.appModel.sessionGroups
    }

    private var enabled: Bool {
        self.appModel.isOperatorGatewayConnected || ScreenshotFixtureMode.groupControlsEnabled
    }

    private var names: [String] {
        self.groups.names(for: self.sessions)
    }

    var body: some View {
        SessionSectionHeader(
            title: self.name,
            isCollapsed: Binding(
                get: { self.groups.collapsed.contains(self.name) },
                set: { collapsed in
                    if collapsed {
                        self.groups.collapsed.insert(self.name)
                    } else {
                        self.groups.collapsed.remove(self.name)
                    }
                }),
            id: "SessionGroup.Header.\(self.name)")
            .overlay(alignment: .trailing) {
                HStack(spacing: 8) {
                    if self.busy {
                        ProgressView().controlSize(.mini)
                            .accessibilityIdentifier("SessionGroup.Pending.\(self.name)")
                    }
                    self.accessory()
                }
                .padding(.trailing, 10)
            }
            .contextMenu { self.menu }
            .alert(
                self.editor == .create ? String(localized: "New Group") : String(localized: "Rename Group"),
                isPresented: Binding(get: { self.editor != nil }, set: { if !$0 { self.editor = nil } }))
            {
                TextField("Group name", text: self.$draft).font(OpenClawType.body)
                Button { self.commitEditor() } label: {
                    Text(self.editor == .create ? LocalizedStringKey("Create") : LocalizedStringKey("Save"))
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) { self.editor = nil } label: {
                    Text("Cancel").font(OpenClawType.subheadSemiBold)
                }
            }
            .alert("Delete Group?", isPresented: self.$confirmsDelete) {
                    Button(role: .destructive) { self.deleteGroup() } label: {
                        Text("Delete Group").font(OpenClawType.subheadSemiBold)
                    }
                    Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.subheadSemiBold) }
                } message: {
                    Text(verbatim: String(
                        format: String(localized: "Sessions in “%@” move back to Ungrouped."),
                        self.name))
                        .font(OpenClawType.caption)
                }
                .sheet(item: self.$defaultsModel) { model in
                    ChatSessionGroupDefaultsSheet(model: model)
                }
    }

    @ViewBuilder
    private var menu: some View {
        Button { self.newSession() } label: {
            Label("New Session in This Group", systemImage: "plus.bubble").font(OpenClawType.subhead)
        }.disabled(!self.enabled || self.groups.connection == nil || self.busy || self.groups.submitting ||
            (self.groups.usesCatalog && !self.groups.allows("sessions.create")))
        Button {
            guard let connection = self.groups.connection else { return }
            self.defaultsModel = ChatSessionGroupDefaultsModel(
                name: self.name,
                connection: connection,
                agentWorkspace: self.appModel.gatewayAgents.first { $0.id == self.appModel.chatAgentId }?.workspace)
        } label: {
            Label("New Session Defaults…", systemImage: "slider.horizontal.3").font(OpenClawType.subhead)
        }.disabled(!self.groups.allows("sessions.groups.update") ||
            self.groups.connection?.allows("sessions.groups.defaults", scope: "operator.read") != true)
        Button { self.draft = self.name
            self.editor = .rename
        } label: {
            Label("Rename Group…", systemImage: "pencil").font(OpenClawType.subhead)
        }.disabled(!self.canMutate("sessions.groups.rename"))
        Button { self.draft = ""
            self.editor = .create
        } label: {
            Label("New Group…", systemImage: "folder.badge.plus").font(OpenClawType.subhead)
        }.disabled(!self.canMutate("sessions.groups.put"))
        Button { self.move(-1) } label: {
            Label("Move Up", systemImage: "arrow.up").font(OpenClawType.subhead)
        }.disabled(!self.canMutate("sessions.groups.put") || self.names.first == self.name)
        Button { self.move(1) } label: {
            Label("Move Down", systemImage: "arrow.down").font(OpenClawType.subhead)
        }.disabled(!self.canMutate("sessions.groups.put") || self.names.last == self.name)
        Button(role: .destructive) { self.confirmsDelete = true } label: {
            Label("Delete Group…", systemImage: "trash").font(OpenClawType.subhead)
        }.disabled(!self.canMutate("sessions.groups.delete"))
    }

    private func canMutate(_ method: String) -> Bool {
        self.enabled && self.groups.connection != nil && !self.busy && !self.groups.submitting &&
            (!self.groups.usesCatalog || self.groups.allows(method))
    }

    private func commitEditor() {
        let editor = self.editor
        self.editor = nil
        let value = self.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let names = self.names
        let request = editor == .create
            ? OpenClawChatGatewayRequests.sessionGroupsPut(names: SessionGroupStore.adding(names, value))
            : OpenClawChatGatewayRequests.sessionGroupsRename(name: self.name, to: value)
        Task {
            guard !self.busy else { return }
            self.busy = true
            defer { self.busy = false }
            await self.groups.mutate(
                appModel: self.appModel,
                request: request,
                catalogNames: { SessionGroupStore.adding($0, value) },
                fallback: { connection in
                    if editor == .rename { try await self.patchMembers(connection, category: value) }
                    SessionGroupStore.save(editor == .create
                        ? SessionGroupStore.adding(names, value)
                        : SessionGroupStore.renaming(names, from: self.name, to: value))
                })
            if self.groups.failure == nil, editor == .rename,
               self.groups.collapsed.remove(self.name) != nil { self.groups.collapsed.insert(value) }
            await self.refresh()
        }
    }

    private func deleteGroup() {
        let names = self.names
        Task {
            guard !self.busy else { return }
            self.busy = true
            defer { self.busy = false }
            await self.groups.mutate(
                appModel: self.appModel, request: OpenClawChatGatewayRequests.sessionGroupsDelete(name: self.name))
            { connection in
                try await self.patchMembers(connection, category: nil)
                SessionGroupStore.save(SessionGroupStore.removing(names, self.name))
            }
            if self.groups.failure == nil { self.groups.collapsed.remove(self.name) }
            await self.refresh()
        }
    }

    private func move(_ offset: Int) {
        let names = OpenClawChatSessionGroupCatalog.moving(self.name, by: offset, in: self.names)
        Task {
            guard !self.busy else { return }
            self.busy = true
            defer { self.busy = false }
            await self.groups.mutate(
                appModel: self.appModel,
                request: OpenClawChatGatewayRequests.sessionGroupsPut(names: names),
                sessions: self.sessions,
                catalogNames: { OpenClawChatSessionGroupCatalog.moving(self.name, by: offset, in: $0) },
                fallback: { _ in SessionGroupStore.save(names) })
            await self.refresh()
        }
    }

    private func patchMembers(_ connection: OpenClawSessionMenuConnection, category: String?) async throws {
        // Keep legacy membership reads and patches on the same captured Gateway route as catalog operations.
        let agent = self.appModel.chatAgentId
        let active = try await OpenClawChatGatewayPayloadCodec.decodeSessionsList(
            connection.request(OpenClawChatGatewayRequests.sessionsList(
                limit: 10000, search: nil, archived: false, agentID: agent)), agentID: agent)
        let archived = try await OpenClawChatGatewayPayloadCodec.decodeSessionsList(
            connection.request(OpenClawChatGatewayRequests.sessionsList(
                limit: 10000, search: nil, archived: true, agentID: agent)), agentID: agent)
        var firstError: (any Error)?
        for member in CommandSessionGrouping.members(of: self.name, in: [active.sessions, archived.sessions]) {
            do {
                try await connection.request(OpenClawChatGatewayRequests.patchSession(
                    sessionKey: member.key,
                    agentID: OpenClawChatSessionKey.agentID(from: member.key) ?? agent,
                    label: nil,
                    category: .some(category),
                    pinned: nil,
                    archived: nil,
                    unreadPatch: nil))
            } catch { firstError = firstError ?? error }
        }
        if let firstError { throw firstError }
    }

    private func newSession() {
        let agent = self.appModel.chatAgentId
        guard let connection = self.groups.connection, self.enabled, connection.isCurrent() else { return }
        let identity = self.appModel.chatViewModelIdentityID
        Task {
            do {
                let key = "agent:\(agent):dashboard:\(UUID().uuidString.lowercased())"
                let response: OpenClawChatCreateSessionResponse
                if self.groups.usesCatalog {
                    var cwd: String?
                    var worktree: Bool?
                    if connection.allows("sessions.groups.defaults", scope: "operator.read") {
                        let response: SessionsGroupsDefaultsResult = try await connection
                            .read("sessions.groups.defaults")
                        let defaults = response.defaults.first(where: { $0.name == self.name })
                        cwd = defaults?.cwd
                        worktree = defaults?.worktree
                    }
                    let request = OpenClawChatGatewayRequests.createSession(
                        key: key,
                        agentID: agent,
                        label: nil,
                        parentSessionKey: nil,
                        worktree: worktree,
                        category: self.name,
                        cwd: cwd)
                    response = try await JSONDecoder().decode(
                        OpenClawChatCreateSessionResponse.self, from: connection.request(request))
                } else {
                    response = try await JSONDecoder().decode(
                        OpenClawChatCreateSessionResponse.self,
                        from: connection.request(OpenClawChatGatewayRequests.createSession(
                            key: key,
                            agentID: agent,
                            label: nil,
                            parentSessionKey: nil,
                            worktree: nil)))
                    try await connection.request(OpenClawChatGatewayRequests.patchSession(
                        sessionKey: response.key,
                        agentID: agent,
                        expectedSessionID: response.sessionId,
                        label: nil,
                        category: .some(self.name),
                        pinned: nil,
                        archived: nil,
                        unreadPatch: nil))
                }
                await self.refresh()
                guard self.appModel.chatViewModelIdentityID == identity, connection.isCurrent() else { return }
                self.openSession(response.key)
            } catch { self.groups.report(error) }
        }
    }
}
