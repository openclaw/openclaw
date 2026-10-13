import OpenClawKit
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(\.scenePhase) var scenePhase
    let directRoute: AgentRoute
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let headerTitle = "Agents"
    let openSettings: () -> Void
    @State var agentRosterFilter: AgentRosterFilter = .all
    @State var agentSearchText = ""

    enum AgentRoute: Hashable {
        case agents
        case files
    }

    enum AgentRosterFilter: String, CaseIterable, Identifiable {
        case all
        case online
        case ready

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: String(localized: "All")
            case .online: String(localized: "Online")
            case .ready: String(localized: "Ready")
            }
        }

        var systemImage: String {
            switch self {
            case .all: "person.2"
            case .online: "antenna.radiowaves.left.and.right"
            case .ready: "checkmark.circle"
            }
        }
    }

    enum AgentRosterState: Equatable {
        case online
        case ready

        var color: Color {
            switch self {
            case .online: OpenClawBrand.ok
            case .ready: OpenClawBrand.info
            }
        }
    }

    var body: some View {
        self.destination(for: self.directRoute)
            .toolbar(
                self.directRoute != .agents && self.headerSidebarAction != nil ? .hidden : .visible,
                for: .navigationBar)
            .task(id: self.rosterTaskID) {
                await self.refreshAgents()
            }
    }
}
