#if os(macOS)
import AppKit
import OpenClawProtocol
import SwiftUI

extension ChatSessionSidebar {
    var catalogPresentation: ChatSidebarCatalogPresentation {
        ChatSidebarCatalogPresentation(
            sources: self.catalogData.agentID == self.viewModel.selectedAgentID ?
                self.catalogData.visible(archived: false) : [],
            requestErrors: self.catalogData.errors,
            query: self.viewModel.sidebarData?.query ?? .init(agentID: self.viewModel.selectedAgentID),
            allAgents: self.rosterData?.agentScope == .all,
            lookup: { self.viewModel.rosterEntry(
                key: $0, agentID: OpenClawChatSessionKey.agentID(from: $0) ?? self.viewModel.selectedAgentID) })
    }

    func catalogSections(
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        ChatSidebarCatalogSections(
            data: self.catalogData,
            viewModel: self.viewModel,
            projection: self.catalogPresentation,
            ownership: ownership,
            ownerFilter: self.$sessionOwnerFilter)
        { row, menu in
            AnyView(self.row(
                for: ChatSessionSidebarModel.tree(from: [row])[0],
                isChild: false,
                now: now,
                ownership: ownership,
                previewRequest: previewRequest,
                menu: menu))
        }
    }
}

struct ChatSidebarCatalogVisibilityOptions: View {
    let data: ChatSessionSidebarCatalogs
    @Binding var ownerFilter: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Session catalogs").fontWeight(.semibold)
            if !self.ownerFilter.isEmpty {
                Button("Show all owners") { self.ownerFilter = "" }
            }
            ForEach(ChatSidebarCatalogPresentation.visibilityOptions(
                self.data.catalogs,
                hidden: self.data.hidden))
            { item in
                Toggle(isOn: Binding(get: { !self.data.hidden.contains(item.id) }, set: {
                    self.data.setHidden(item.id, !$0)
                    if $0 { self.data.scheduleRefresh() }
                })) { Text(verbatim: item.label) }
            }
            Button("Session sources…") { self.data.connection?.openSources() }
                .disabled(self.data.connection == nil)
        }
    }
}

private struct ChatSidebarCatalogSections: View {
    let data: ChatSessionSidebarCatalogs
    let viewModel: OpenClawChatViewModel
    let projection: ChatSidebarCatalogPresentation
    let ownership: ChatSidebarOwnership
    @Binding var ownerFilter: String
    let liveRow: (OpenClawChatSessionEntry, AnyView) -> AnyView
    @State private var expanded: Set<String> = []
    @State private var collapsed: Set<String> = []

    var body: some View {
        ForEach(self.projection.catalogs) { catalog in
            Section {
                if !self.collapsed.contains(catalog.id) {
                    ForEach(catalog.hosts) { host in
                        if host.source.kind.value as? String == "node" {
                            Label(
                                host.source.label,
                                systemImage: host.source.connected ? "desktopcomputer" : "wifi.slash")
                                .font(OpenClawChatTypography.caption).foregroundStyle(.secondary)
                                .selectionDisabled()
                        }
                        ForEach(self.data.groups(host.rows)) { group in
                            let groupID = "\(catalog.id)\0\(host.id)\0\(group.id)"
                            if let label = group.label { self.heading(label, id: groupID) }
                            if !self.collapsed.contains(groupID) {
                                ForEach(
                                    Array(group.rows.prefix(self.expanded.contains(groupID) ? group.rows.count : 5)),
                                    id: \.threadid)
                                { row in
                                    ChatSidebarCatalogRow(
                                        data: self.data,
                                        viewModel: self.viewModel,
                                        catalog: catalog.source,
                                        host: host.source,
                                        row: row,
                                        live: row.sessionkey.flatMap { self.projection.liveRows[$0] },
                                        liveRow: self.liveRow)
                                }
                                if group.rows.count > 5 {
                                    Button(self.expanded.contains(groupID) ? String(localized: "Show less") :
                                        String(localized: "Show more"))
                                    {
                                        Self.toggle(groupID, in: &self.expanded)
                                    }.selectionDisabled()
                                }
                            }
                        }
                    }
                    self.pageState(catalog.source)
                }
            } header: {
                self.heading(catalog.source.label, id: catalog.id)
                    .contextMenu { self.headerMenu(catalog.source) }
            }
        }
        if self.data.agentID == self.viewModel.selectedAgentID,
           let error = self.data.errors[""], self.viewModel.sidebarData?.query.status != .archived,
           self.viewModel.sidebarData?.agentScope != .all
        {
            Text(verbatim: error).foregroundStyle(.secondary).selectionDisabled()
            Button("Retry") { self.data.scheduleRefresh() }.disabled(self.data.connection == nil)
                .selectionDisabled()
        }
    }

    private func heading(_ label: String, id: String) -> some View {
        Button { Self.toggle(id, in: &self.collapsed) } label: {
            HStack {
                Image(systemName: self.collapsed.contains(id) ? "chevron.right" : "chevron.down")
                Text(verbatim: label)
            }.font(OpenClawChatTypography.caption)
        }.buttonStyle(.plain).selectionDisabled()
    }

    private static func toggle(_ id: String, in values: inout Set<String>) {
        if !values.insert(id).inserted { values.remove(id) }
    }

    @ViewBuilder private func pageState(_ catalog: SessionCatalog) -> some View {
        let errors = ChatSidebarCatalogPresentation.errors(catalog, requestError: self.data.errors[catalog.id])
        ForEach(errors, id: \.self) { Text(verbatim: $0).foregroundStyle(.secondary).selectionDisabled() }
        if self.data.loading.contains(catalog.id) {
            ProgressView().selectionDisabled()
        } else {
            // A failed host may have no cursor; paging its healthy peers cannot retry that failure.
            if !errors.isEmpty {
                Button("Retry") { self.data.scheduleRefresh() }.disabled(self.data.connection == nil)
                    .selectionDisabled()
            }
            if catalog.hosts.contains(where: { $0.nextcursor?.isEmpty == false }) {
                Button("Load more") { Task { await self.data.loadMore(catalog.id) } }
                    .disabled(self.data.connection == nil).selectionDisabled()
            }
        }
    }

    @ViewBuilder private func headerMenu(_ catalog: SessionCatalog) -> some View {
        Picker("Group by", selection: Binding(get: { self.data.grouping }, set: { self.data.setGrouping($0) })) {
            Text("Project").tag(ChatSessionSidebarCatalogs.Grouping.project)
            Text("Person").tag(ChatSessionSidebarCatalogs.Grouping.person)
            Text("None").tag(ChatSessionSidebarCatalogs.Grouping.none)
        }
        Picker("Owner", selection: self.$ownerFilter) {
            Text("All owners").tag("")
            Text("Involving me").tag("involving-me")
            ForEach(self.ownership.owners, id: \.id) { actor in
                if let id = actor.id {
                    Text(verbatim: actor.label ?? id).tag("owner:\(id)")
                }
            }
            if self.ownerFilter.hasPrefix("owner:"),
               !self.ownership.owners.contains(where: { self.ownerFilter == "owner:\($0.id ?? "")" })
            {
                Text(verbatim: String(self.ownerFilter.dropFirst(6))).tag(self.ownerFilter)
            }
        }
        Button("Hide from sidebar") { self.data.setHidden(catalog.id, true) }
    }
}

private struct ChatSidebarCatalogRow: View {
    let data: ChatSessionSidebarCatalogs
    let viewModel: OpenClawChatViewModel
    let catalog: SessionCatalog
    let host: SessionCatalogHost
    let row: SessionCatalogSession
    let live: OpenClawChatSessionEntry?
    let liveRow: (OpenClawChatSessionEntry, AnyView) -> AnyView
    @State private var deleting: Deletion?

    private struct Deletion {
        let catalog: SessionCatalog
        let host: SessionCatalogHost
        let row: SessionCatalogSession
        let connection: OpenClawSidebarCatalogConnection
        let scopeID: UUID
        let sourceTarget: OpenClawChatSessionTarget
        let agentID: String
        let title: String
    }

    private var target: OpenClawChatSessionTarget {
        ChatSidebarCatalogPresentation.target(
            catalogID: self.catalog.id, hostID: self.host.hostid, row: self.row, agentID: self.data.agentID)
    }

    var body: some View {
        Group {
            if let live {
                self.liveRow(live, AnyView(self.menu))
            } else {
                HStack(spacing: 8) {
                    if self.row.status == "active" || self.row.status == "running" {
                        ProgressView().controlSize(.small).accessibilityLabel(String(localized: "Thread running"))
                    } else { Image(systemName: "bubble.left").foregroundStyle(.secondary) }
                    Text(verbatim: ChatSidebarCatalogPresentation.title(self.row)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
                .padding(.vertical, 4).contentShape(Rectangle())
                .tag(OpenClawChatSessionSidebarData.identity(.init(
                    key: self.target.sessionKey, agentId: self.target.agentID)))
                .overlay(alignment: .leading) { OpenClawSessionColorStripe(color: self.row.color).offset(x: -6) }
                .contextMenu { self.menu }
            }
        }
        .confirmationDialog(self.deleting?.title ?? "", isPresented: Binding(
            get: { self.deleting != nil }, set: { if !$0 { self.deleting = nil } }))
        {
            Button("Delete session", role: .destructive) {
                guard let item = self.deleting else { return }
                self.deleting = nil
                Task { await self.delete(item) }
            }
        } message: { Text("Make sure no other runner is using this session before deleting it.") }
    }

    @ViewBuilder private var menu: some View {
        Button("Open in OpenClaw") {
            self.viewModel.switchSession(to: self.target.sessionKey, agentID: self.target.agentID)
        }
        if self.catalog.capabilities.archive, self.row.canarchive {
            Button("Delete session", role: .destructive) {
                guard let connection = self.data.connection else { return }
                self.deleting = Deletion(
                    catalog: self.catalog,
                    host: self.host,
                    row: self.row,
                    connection: connection,
                    scopeID: self.data.scopeID,
                    sourceTarget: ChatSidebarCatalogPresentation.sourceTarget(
                        catalogID: self.catalog.id,
                        hostID: self.host.hostid,
                        row: self.row,
                        agentID: self.data.agentID),
                    agentID: self.data.agentID,
                    title: ChatSidebarCatalogPresentation.title(self.row))
            }.disabled(self.data.connection?.allowsArchive != true)
        }
    }

    private func delete(_ item: Deletion) async {
        // app-sidebar-catalog-menu.ts:138 rejects confirmations from an expired catalog scope.
        guard item.connection.isCurrent(), self.data.scopeID == item.scopeID, self.data.agentID == item.agentID,
              self.viewModel.selectedAgentID == item.agentID
        else {
            let format = String(localized: "The connection changed. Reopen the menu to delete %@.")
            NSAlert(error: NSError(domain: "OpenClaw", code: 1, userInfo: [
                NSLocalizedDescriptionKey: String(format: format, item.title),
            ])).runModal()
            return
        }
        if await self.data.archive(item.catalog, host: item.host, row: item.row),
           item.connection.isCurrent(), self.data.scopeID == item.scopeID,
           ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(
               item.sourceTarget, current: .init(
                   sessionKey: self.viewModel.sessionKey,
                   agentID: self.viewModel.selectedAgentID))
        {
            self.viewModel.switchSession(to: self.viewModel.selectedAgentMainSessionKey, agentID: item.agentID)
        }
    }
}

struct ChatSidebarCatalogLifecycle: ViewModifier {
    let data: ChatSessionSidebarCatalogs
    let viewModel: OpenClawChatViewModel
    @State private var visible = false

    func body(content: Content) -> some View {
        // Text search owns roster reads; it does not invalidate catalog pages.
        content.background(CatalogSidebarVisibility(visible: self.$visible))
            .onAppear { self.data.isRendered = true }
            .onDisappear { self.data.isRendered = false
                self.data.stop()
            }
            .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
                self.data.reloadPreferences()
            }
            .onChange(of: self.viewModel.sidebarData?.query.ownerId) { self.data.scheduleRefresh() }
            .onChange(of: self.viewModel.sidebarData?.query.involvingMe) { self.data.scheduleRefresh() }
            .onChange(of: self.viewModel.sidebarData?.query.status) { self.data.scheduleRefresh() }
            .onChange(of: self.viewModel.sidebarData?.agentScope) { self.data.scheduleRefresh() }
            .task(id: "\(self.visible)|\(self.viewModel.selectedAgentID ?? "")") {
                guard self.visible, let agentID = self.viewModel.selectedAgentID,
                      let transport = self.viewModel.defaultTransport as? any OpenClawSidebarCatalogTransport
                else { self.data.stop()
                    return
                }
                self.data.hasVisibleRows = { [weak viewModel = self.viewModel] catalog in
                    guard let viewModel else { return false }
                    if viewModel.sidebarData?.agentScope == .all || viewModel.sidebarData?.query.status == .archived {
                        return true
                    }
                    return ChatSidebarCatalogPresentation(
                        sources: [catalog],
                        query: viewModel.sidebarData?.query ?? .init(agentID: viewModel.selectedAgentID),
                        allAgents: false,
                        lookup: { viewModel.rosterEntry(
                            key: $0, agentID: OpenClawChatSessionKey.agentID(from: $0) ?? viewModel.selectedAgentID) })
                        .hasVisibleRows
                }
                await self.data.observe(transport.catalogEvents(), agentID: agentID)
            }
    }
}

private struct CatalogSidebarVisibility: NSViewRepresentable {
    @Binding var visible: Bool
    func makeNSView(context: Context) -> Probe {
        Probe()
    }

    func updateNSView(_ view: Probe, context: Context) {
        view.changed = { self.visible = $0 }
        view.updateVisibility()
    }

    final class Probe: NSView {
        var changed: ((Bool) -> Void)?
        private var windowObserver: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) }
            self.windowObserver = nil
            if let window {
                self.windowObserver = NotificationCenter.default.addObserver(
                    forName: NSWindow.didChangeOcclusionStateNotification,
                    object: window,
                    queue: .main)
                { [weak self] _ in
                    Task { @MainActor in self?.updateVisibility() }
                }
            }
            self.updateVisibility()
        }

        func updateVisibility() {
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.changed?(self.window?.occlusionState.contains(.visible) == true &&
                    !self.isHiddenOrHasHiddenAncestor && !self.visibleRect.isEmpty)
            }
        }

        override func viewDidHide() {
            self.updateVisibility()
        }

        override func viewDidUnhide() {
            self.updateVisibility()
        }

        override func layout() {
            super.layout()
            self.updateVisibility()
        }

        isolated deinit {
            if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) }
        }
    }
}
#endif
