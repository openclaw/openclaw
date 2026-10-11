import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct RootSidebarAgentPicker: View {
    @Environment(\.dismiss) private var dismiss
    let agents: [AgentSummary]
    let selectedID: String?
    @Binding var pinnedIDs: Set<String>
    let select: (String) -> Void
    let selectAll: () -> Void
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                Button(action: self.selectAll) {
                    Label("All Agents", systemImage: "person.3").font(OpenClawType.subhead)
                }
                ForEach(self.visibleAgents, id: \.id) { agent in
                    Button { self.select(agent.id) } label: {
                        HStack {
                            Text(verbatim: RootSidebar.agentDisplayName(agent)).font(OpenClawType.subhead)
                            Spacer()
                            if self.pinnedIDs.contains(agent.id) { Image(systemName: "pin.fill") }
                            if self.selectedID == agent.id { Image(systemName: "checkmark") }
                        }.contentShape(Rectangle())
                    }
                    .contextMenu {
                        Button {
                            if !self.pinnedIDs.insert(agent.id).inserted { self.pinnedIDs.remove(agent.id) }
                        } label: {
                            Label(
                                self.pinnedIDs.contains(agent.id) ? "Unpin Agent" : "Pin Agent",
                                systemImage: self.pinnedIDs.contains(agent.id) ? "pin.slash" : "pin")
                                .font(OpenClawType.subhead)
                        }
                    }
                }
            }
            .searchable(text: self.$search, prompt: "Search Agents")
            .navigationTitle("Agents")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { self.dismiss() } label: { Text("Done").font(OpenClawType.subheadSemiBold) }
                }
            }
        }
    }

    private var visibleAgents: [AgentSummary] {
        self.agents.filter { agent in
            self.search.isEmpty || RootSidebar.agentDisplayName(agent).localizedCaseInsensitiveContains(self.search) ||
                agent.id.localizedCaseInsensitiveContains(self.search)
        }.sorted { lhs, rhs in
            let left = self.pinnedIDs.contains(lhs.id), right = self.pinnedIDs.contains(rhs.id)
            if left != right { return left }
            return RootSidebar.agentDisplayName(lhs)
                .localizedStandardCompare(RootSidebar.agentDisplayName(rhs)) == .orderedAscending
        }
    }
}
