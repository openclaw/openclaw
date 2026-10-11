import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension EnvironmentValues {
    @Entry var commandSessionMenuConnection: OpenClawSessionMenuConnection?
}

enum CommandSessionMenuPresentation: String, Identifiable {
    case appearance, assignment, open, rename, newGroup
    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .appearance: String(localized: "Icon & Color")
        case .assignment: String(localized: "Assign to")
        case .open: String(localized: "Open in")
        case .rename: String(localized: "Rename Session")
        case .newGroup: String(localized: "New Group")
        }
    }
}

enum CommandSessionLink {
    static func url(
        config: GatewayConnectConfig?,
        canonicalBase: String?,
        session: OpenClawChatSessionEntry,
        preview: Bool) -> URL?
    {
        guard let path = OpenClawSessionLink.path(sessionKey: session.key, agentID: session.agentId),
              let base = canonicalBase.flatMap(URL.init(string:)) ??
              AuthenticatedControlUI.pageURL(config: config, path: "", queryItems: []),
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        if components.scheme == "ws" { components.scheme = "http" }
        if components.scheme == "wss" { components.scheme = "https" }
        guard components.scheme == "http" || components.scheme == "https" else { return nil }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        while components.percentEncodedPath.hasSuffix("/") {
            components.percentEncodedPath.removeLast()
        }
        components.percentEncodedPath += (preview ? "/share" : "") + path
        return components.url
    }
}

/// Detailed pickers stay native and are loaded only after the user chooses their long-press action.
struct CommandSessionMenuSheet: View {
    let presentation: CommandSessionMenuPresentation
    let session: OpenClawChatSessionEntry
    let connection: OpenClawSessionMenuConnection
    let didMutate: () -> Void
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var actions: ChatSessionSidebarActions?
    @State private var agents: [OpenClawChatAgentChoice] = []
    @State private var customIcon = ""
    @State private var color: String?
    @State private var icon: String?
    @State private var failure: String?
    @State private var saving = false
    @State private var showsWeb = false
    @State private var facts = OpenClawChatSidebarHoverFacts()
    @State private var ownerSearch = ""
    @State private var nameDraft = ""

    var body: some View {
        NavigationStack {
            List {
                if let failure { Text(failure).font(OpenClawType.body).foregroundStyle(OpenClawBrand.danger) }
                if !self.connection.isCurrent() {
                    Text("The gateway connection changed. Close this menu and open it again.")
                        .font(OpenClawType.body)
                }
                switch self.presentation {
                case .appearance: self.appearance
                case .assignment: self.assignment
                case .open: self.destinations
                case .rename, .newGroup: self.nameEditor
                }
            }
            .scrollContentBackground(.hidden)
            .background(OpenClawProBackground())
            .navigationTitle(self.presentation.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { self.dismiss() } label: { Text("Done").font(OpenClawType.subheadSemiBold) }
                }
            }
            .disabled(self.saving)
            .overlay { if self.saving { ProgressView().accessibilityLabel("Saving") } }
            .navigationDestination(isPresented: self.$showsWeb) {
                CommandSessionWebScreen(session: self.session, connection: self.connection)
            }
        }
        .tint(OpenClawBrand.accent)
        .task {
            self.color = self.session.color
            self.icon = self.session.icon
            if self.presentation == .rename { self.nameDraft = self.session.label ?? "" }
            if self.presentation == .assignment { await self.loadAssignment() }
            if self.presentation == .open { await self.observeWork() }
        }
    }

    @ViewBuilder
    private var nameEditor: some View {
        TextField(
            text: self.$nameDraft,
            prompt: Text(self.presentation == .rename ? "Session name" : "Group name")
                .font(OpenClawType.body))
        {
            Text(self.presentation == .rename ? "Session name" : "Group name").font(OpenClawType.body)
        }.font(OpenClawType.body).autocorrectionDisabled()
        Button { self.saveName() } label: {
            Text(self.presentation == .rename ? "Save" : "Create").font(OpenClawType.subheadSemiBold)
        }.disabled(!self.connection.isCurrent() ||
            (self.presentation == .newGroup && self.nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                .isEmpty))
    }

    private func saveName() {
        let value = self.nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.presentation == .rename {
            self.save(.rename, fields: ["label": value.isEmpty ? .init(NSNull()) : .init(value)]) { self.dismiss() }
            return
        }
        guard !value.isEmpty else { return }
        self.saving = true
        self.failure = nil
        Task {
            defer { self.saving = false }
            do {
                guard self.connection.allows(.group, session: self.session) else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                let groups = self.appModel.sessionGroups
                await groups.mutate(
                    appModel: self.appModel,
                    request: OpenClawChatGatewayRequests.sessionGroupsPut(names: []),
                    connection: self.connection,
                    catalogNames: { SessionGroupStore.adding($0, value) },
                    fallback: { _ in SessionGroupStore.remember(value) })
                if let failure = groups.failure {
                    self.failure = failure
                    return
                }
                try await self.connection.request(OpenClawChatGatewayRequests.sessionMenu(
                    "sessions.patch", session: self.session, fields: ["category": .init(value)]))
                self.didMutate()
                self.dismiss()
            } catch { self.failure = error.localizedDescription }
        }
    }

    private var appearance: some View {
        Group {
            Section {
                OpenClawSessionColorMenu(color: self.color) { value in
                    self.save(
                        .appearance,
                        fields: ["color": value.map(OpenClawProtocol.AnyCodable.init) ?? .init(NSNull())])
                    {
                        self.color = value
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))], spacing: 12) {
                    ForEach(ChatSessionSidebarActions.emoji, id: \.self) { value in
                        Button { self.setIcon(value) } label: {
                            Text(verbatim: value).font(OpenClawType.title2)
                                .frame(minWidth: 44, minHeight: 44)
                                .background(
                                    self.icon == value ? OpenClawBrand.accent.opacity(0.18) : .clear,
                                    in: RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain)
                    }
                    ForEach(ChatSessionSidebarActions.iconGlyphs, id: \.0) { value in
                        Button { self.setIcon(value.0) } label: {
                            Image(systemName: value.1).font(OpenClawType.title2).frame(minWidth: 44, minHeight: 44)
                                .background(
                                    self.icon == value.0 ? OpenClawBrand.accent.opacity(0.18) : .clear,
                                    in: RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain).accessibilityLabel(value.0)
                    }
                }
                Button { self.setIcon(nil) } label: {
                    Label("No Icon", systemImage: "xmark.circle").font(OpenClawType.body)
                }
            } header: { Text("Appearance").font(OpenClawType.captionSemiBold) }
            Section {
                TextField(text: self.$customIcon, prompt: Text("Custom emoji").font(OpenClawType.body)) {
                    Text("Custom emoji").font(OpenClawType.body)
                }.font(OpenClawType.body)
                Button { self.setIcon(self.customIcon.trimmingCharacters(in: .whitespacesAndNewlines)) } label: {
                    Text("Use Emoji").font(OpenClawType.subheadSemiBold)
                }.disabled(!ChatSessionSidebarActions.acceptsCustomEmoji(self.customIcon))
            }
            Button {
                self.save(.appearance, fields: ["icon": .init(NSNull()), "color": .init(NSNull())]) {
                    self.icon = nil
                    self.color = nil
                }
            } label: { Label("Reset Appearance", systemImage: "arrow.counterclockwise").font(OpenClawType.body) }
        }.disabled(!self.connection.allows(.appearance, session: self.session))
    }

    @ViewBuilder private var assignment: some View {
        if let actions {
            let owners = actions.owners(session: self.session, agents: self.agents).filter {
                self.ownerSearch.isEmpty || $0.label.localizedCaseInsensitiveContains(self.ownerSearch) ||
                    $0.key.localizedCaseInsensitiveContains(self.ownerSearch)
            }
            TextField(text: self.$ownerSearch, prompt: Text("Search people and agents").font(OpenClawType.body)) {
                Text("Search people and agents").font(OpenClawType.body)
            }.font(OpenClawType.body).autocorrectionDisabled()
            if actions.loadingOwners { ProgressView().accessibilityLabel("Loading people") }
            ForEach(owners) { owner in
                let checked = self.session.owner?.actor.type == owner.type &&
                    ChatSessionSidebarActions.ownerID(self.session.owner?.actor) == owner.key
                Button {
                    self.save(.assignOwner, fields: ["owner": .init(["type": owner.type, "id": owner.key])]) {
                        self.dismiss()
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: owner.type == "human" ? "person.crop.circle" : "cpu")
                        VStack(alignment: .leading) {
                            Text(verbatim: owner.label).font(OpenClawType.body)
                            Text(owner.type == "human" ? "Person" : "Agent").font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if checked { Image(systemName: "checkmark") }
                    }
                }.disabled(checked || !self.connection.allows(.assignOwner, session: self.session))
            }
            if let error = actions.directoryError {
                Text(error).font(OpenClawType.caption).foregroundStyle(.secondary)
                Button { Task { await self.loadAssignment() } } label: {
                    Label("Retry Directory", systemImage: "arrow.clockwise").font(OpenClawType.body)
                }.disabled(actions.loadingOwners)
            } else if owners.isEmpty, !actions.loadingOwners {
                Text("No owners are available.").font(OpenClawType.body)
            }
        } else { ProgressView().accessibilityLabel("Loading people") }
    }

    private var destinations: some View {
        Group {
            if let url = self.connection.link(self.session, false) {
                Button { self.showsWeb = true } label: {
                    Label("Web Conversation", systemImage: "globe").font(OpenClawType.body)
                }
                Button { self.openURL(url) } label: {
                    Label("Browser", systemImage: "safari").font(OpenClawType.body)
                }
                ShareLink(item: url) {
                    Label("Share Session Link", systemImage: "square.and.arrow.up").font(OpenClawType.body)
                }
            }
            if let pr = self.facts.pullRequests(sessionKey: self.session.key, agentID: self.session.agentId)?
                .menuPullRequest,
                let url = URL(string: pr.url), url.scheme.map({ ["https", "http"].contains($0) }) == true
            {
                Link(destination: url) {
                    Label(
                        String(format: String(localized: "Open Pull Request #%@"), String(pr.number)),
                        systemImage: "arrow.triangle.pull")
                        .font(OpenClawType.body)
                }
            }
            if self.session.worktree != nil || self.session.repository != nil {
                if let branch = self.session.worktree?.branch ?? self.session.repository?["branch"]?.value as? String {
                    LabeledContent { Text(verbatim: branch).font(OpenClawType.body) } label: {
                        Text("Branch").font(OpenClawType.body)
                    }
                }
                if self.facts.pullRequests(sessionKey: self.session.key, agentID: self.session.agentId) == nil {
                    Text("Pull request details appear when the gateway provides them.")
                        .font(OpenClawType.caption).foregroundStyle(.secondary)
                }
            }
        }.disabled(!self.connection.isCurrent())
    }

    private func setIcon(_ value: String?) {
        self.save(.appearance, fields: ["icon": value.map(OpenClawProtocol.AnyCodable.init) ?? .init(NSNull())]) {
            self.icon = value
        }
    }

    private func save(
        _ action: OpenClawSessionMenuAction,
        fields: [String: OpenClawProtocol.AnyCodable],
        success: @escaping () -> Void)
    {
        self.saving = true
        Task {
            defer { self.saving = false }
            do {
                guard self.connection.allows(action, session: self.session) else {
                    throw OpenClawChatTransportSendError.notDispatched
                }
                try await self.connection.request(OpenClawChatGatewayRequests.sessionMenu(
                    action.method, session: self.session, fields: fields))
                self.failure = nil
                success()
                self.didMutate()
            } catch { self.failure = error.localizedDescription }
        }
    }

    private func loadAssignment() async {
        let actions = self.actions ?? ChatSessionSidebarActions(connection: self.connection)
        self.actions = actions
        async let owners: Void? = actions.refresh()?.value
        do {
            if self.connection.allows("agents.list", scope: "operator.sessions.read") {
                let catalog: OpenClawChatAgentsListResponse = try await self.connection.read("agents.list")
                self.agents = catalog.agents
                self.failure = nil
            }
        } catch { self.failure = error.localizedDescription }
        _ = await owners
    }

    private func observeWork() async {
        guard self.connection.allows("controlUi.sessionPullRequests.subscribe", scope: "operator.read") else { return }
        let subscription = await self.appModel.operatorSession.makeServerEventSubscription(matching: {
            $0.event == "controlUi.sessionPullRequests.changed"
        })
        guard self.connection.isCurrent(), !Task.isCancelled else { subscription.cancel()
            return
        }
        let connection = self.connection
        self.facts.connect(request: { try await connection.request($0) })
        let owner = self.facts.watch(sessionKey: self.session.key, agentID: self.session.agentId)
        defer {
            self.facts.unwatch(owner)
            self.facts.disconnect()
            subscription.cancel()
        }
        for await event in subscription.events {
            guard connection.isCurrent(), !Task.isCancelled else { return }
            if let payload = event.payload, let data = try? JSONEncoder().encode(payload) {
                self.facts.receive(event: event.event, payload: data)
            }
        }
    }
}

private struct CommandSessionWebScreen: View {
    let session: OpenClawChatSessionEntry
    let connection: OpenClawSessionMenuConnection
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        let config = self.appModel.activeGatewayConnectConfig
        if self.connection.isCurrent(),
           let url = CommandSessionLink.url(config: config, canonicalBase: nil, session: self.session, preview: false)
        {
            AuthenticatedControlUIWebView(
                url: url,
                authScript: AuthenticatedControlUI.authUserScript(
                    config: config,
                    pageURL: url,
                    storedOperatorToken: AuthenticatedControlUI.storedOperatorToken(config: config),
                    usesNativeNavigationChrome: true),
                tls: config?.tls)
                .navigationTitle("Web Conversation")
                .navigationBarTitleDisplayMode(.inline)
        } else {
            Text("Reconnect to open this conversation.").font(OpenClawType.body)
        }
    }
}
