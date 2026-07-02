import OpenClawProtocol
import SwiftUI

struct RootTabsPhoneControlHub: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var navigationPath: [RootTabs.SidebarDestination] = []
    @State private var didApplyInitialDestination = false

    let groups: [RootTabs.SidebarGroup]
    let initialDestination: RootTabs.SidebarDestination?
    let openRootDestination: (RootTabs.SidebarDestination) -> Void

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            List {
                Section {
                    Button {
                        self.openPhoneRootDestination(.gateway)
                    } label: {
                        self.gatewayRow
                    }
                    .buttonStyle(.plain)
                }

                ForEach(self.phoneGroups) { group in
                    Section {
                        ForEach(group.destinations) { destination in
                            self.destinationRow(destination)
                        }
                    } header: {
                        if let title = self.sectionTitle(for: group) {
                            Text(title)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Control")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: RootTabs.SidebarDestination.self) { destination in
                self.detail(for: destination)
            }
            .onAppear {
                self.applyInitialDestinationIfNeeded()
            }
        }
    }

    private var gatewayRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.body.weight(.semibold))
                .foregroundStyle(self.gatewayStateColor)
                .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text("Gateway")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(self.sidebarActiveAgentTitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                ProStatusDot(color: self.gatewayStateColor)
                Text(self.gatewayStateText)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(self.gatewayStateColor)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Gateway \(self.gatewayStateText), \(self.sidebarActiveAgentTitle)")
        .accessibilityHint("Opens Settings / Gateway")
    }

    @ViewBuilder
    private func destinationRow(_ destination: RootTabs.SidebarDestination) -> some View {
        if self.opensRootTab(destination) {
            Button {
                self.openPhoneRootDestination(destination)
            } label: {
                HStack(spacing: 12) {
                    self.rowLabel(destination)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            NavigationLink(value: destination) {
                self.rowLabel(destination)
            }
        }
    }

    private func rowLabel(_ destination: RootTabs.SidebarDestination) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: destination.systemImage)
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
            Text(destination.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 3)
    }

    @ViewBuilder
    private func detail(for destination: RootTabs.SidebarDestination) -> some View {
        switch destination {
        case .chat, .talk, .agents, .gateway:
            EmptyView()
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                usesNativeNavigationChrome: true,
                headerTitle: "Overview",
                showsHeaderMark: false,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) },
                openSessions: { self.navigationPath.append(.sessions) })
        case .activity:
            IPadActivityScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .workboard:
            IPadWorkboardScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                usesNativeNavigationChrome: true,
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerTitle: "Instances",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .sessions:
            CommandSessionsScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openPhoneRootDestination(.chat) })
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerTitle: "Dreaming",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerTitle: "Usage",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerTitle: "Cron Jobs",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .docs:
            OpenClawDocsScreen(
                usesNativeNavigationChrome: true,
                gatewayAction: { self.openPhoneRootDestination(.gateway) })
        case .settings:
            EmptyView()
        }
    }

    private func openPhoneRootDestination(_ destination: RootTabs.SidebarDestination) {
        self.navigationPath.removeAll()
        self.openRootDestination(destination)
    }

    private func opensRootTab(_ destination: RootTabs.SidebarDestination) -> Bool {
        RootTabs.shouldOpenRootTabFromPhoneHub(destination)
    }

    private var phoneGroups: [RootTabs.SidebarGroup] {
        self.groups.compactMap { group in
            let destinations = group.destinations.filter { !self.opensRootTab($0) }
            guard !destinations.isEmpty else { return nil }
            return RootTabs.SidebarGroup(title: group.title, destinations: destinations)
        }
    }

    private func applyInitialDestinationIfNeeded() {
        guard !self.didApplyInitialDestination else { return }
        self.didApplyInitialDestination = true
        guard let initialDestination, initialDestination != .overview else { return }
        if self.opensRootTab(initialDestination) {
            self.openPhoneRootDestination(initialDestination)
        } else {
            self.navigationPath = [initialDestination]
        }
    }

    private var sidebarActiveAgentTitle: String {
        let selectedID = self.normalized(self.appModel.selectedAgentId) ?? self.resolveDefaultAgentID()
        if let agent = self.appModel.gatewayAgents.first(where: { $0.id == selectedID }) {
            return self.agentTitle(for: agent)
        }
        return self.normalized(self.appModel.activeAgentName) ?? "Default Agent"
    }

    private var gatewayStateText: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected: "Online"
        case .connecting: "Connecting"
        case .error: "Attention"
        case .disconnected: "Offline"
        }
    }

    private var gatewayStateColor: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            OpenClawBrand.ok
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private func sectionTitle(for group: RootTabs.SidebarGroup) -> String? {
        switch group.title.lowercased() {
        case "chat": "Communication"
        case "control": nil
        default: group.title.capitalized
        }
    }

    private func resolveDefaultAgentID() -> String {
        self.normalized(self.appModel.gatewayDefaultAgentId) ?? ""
    }

    private func agentTitle(for agent: AgentSummary) -> String {
        let name = self.normalized(agent.name) ?? agent.id
        return name == agent.id ? name : "\(name) (\(agent.id))"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#if DEBUG
#Preview("Phone control hub offline") {
    RootTabsPhoneControlHub.preview(appModel: NodeAppModel())
}

#Preview("Phone control hub connected") {
    let appModel = NodeAppModel()
    appModel.enterAppleReviewDemoMode()
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview("Phone control hub connecting") {
    let appModel = NodeAppModel()
    appModel.gatewayStatusText = "Connecting..."
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview("Phone control hub gateway error") {
    let appModel = NodeAppModel()
    appModel.gatewayStatusText = "Gateway error: connection refused"
    return RootTabsPhoneControlHub.preview(appModel: appModel)
}

#Preview(
    "Phone control hub landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPhoneControlHub.preview(appModel: NodeAppModel())
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

extension RootTabsPhoneControlHub {
    fileprivate static func preview(appModel: NodeAppModel) -> some View {
        RootTabsPhoneControlHub(
            groups: RootTabs.phoneControlGroups,
            initialDestination: nil,
            openRootDestination: { _ in })
            .environment(appModel)
    }
}
#endif
