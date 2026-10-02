#if os(macOS)
import SwiftUI

extension ChatSessionSidebar {
    var rosterData: OpenClawChatSessionSidebarData? {
        self.viewModel.sidebarData.flatMap { $0.isQueryEnabled ? $0 : nil }
    }

    func rosterSections(
        now: Date,
        observedOrder: ChatSessionSidebarModel.ObservedOrder) -> [ChatSessionSidebarModel.Section]
    {
        let data = self.rosterData
        let rows = data?.rowsIncludingLoadedDescendants ?? self.viewModel.sessions
        return ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: self.viewModel.sessionKey,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: data?.query.agentID ?? (data == nil ? self.viewModel.selectedAgentID : nil),
            groups: self.groups,
            excludesMainSession: self.viewModel.selectedAgent != nil,
            query: data == nil ? self.query : "",
            rankedSearch: data?.query.search.isEmpty == false,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract,
            viewOptions: self.filterOptions,
            observedOrder: observedOrder,
            owners: data?.owners,
            selfOwnerID: self.ownership().selfID,
            sectionOrder: self.sectionOrder,
            now: now)
    }
}

struct ChatSessionSidebarRosterState: View {
    let data: OpenClawChatSessionSidebarData

    var body: some View {
        Group {
            if self.data.isLoading {
                ProgressView(String(localized: "Loading threads…"))
            } else if let error = self.data.errorText {
                VStack(alignment: .leading) {
                    Text(verbatim: error).foregroundStyle(.secondary)
                    Button(String(localized: "Retry")) { Task { await self.data.retry() } }
                }
            } else if self.data.searchIndexing {
                Text("Indexing older messages — search again shortly.")
                    .foregroundStyle(.secondary)
            } else if self.data.query.search.isEmpty, self.data.nextOffset != nil {
                Button(String(localized: "Load more")) { Task { await self.data.load(append: true) } }
            }
            // ui/src/components/command-palette-view.ts:264 shows archive exclusions alongside search state.
            if self.data.archivedTranscriptsExcluded > 0 {
                let format = String(
                    localized: "%lld archived transcripts excluded; open a session to restore its searchable history.")
                Text(String(format: format, self.data.archivedTranscriptsExcluded)).foregroundStyle(.secondary)
            }
        }
        .font(OpenClawChatTypography.caption)
        .listRowSeparator(.hidden)
        .selectionDisabled()
    }
}
#endif
