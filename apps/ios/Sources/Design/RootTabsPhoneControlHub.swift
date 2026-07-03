import OpenClawProtocol
import SwiftUI

struct RootTabsPhoneControlHub: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var navigationPath: [RootTabs.SidebarDestination] = []
    @State private var didApplyInitialDestination = false
    @State private var handledNavigationRequestID = 0

    let groups: [RootTabs.SidebarGroup]
    let initialDestination: RootTabs.SidebarDestination?
    let navigationRequest: RootTabs.PhoneControlNavigationRequest?
    let openRootDestination: (RootTabs.SidebarDestination) -> Void
    let openChatFromControlDetail: (RootTabs.SidebarDestination) -> Void

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            List {
                Section {
                    Button {
                        self.openGatewayDetail()
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
                self.applyNavigationRequestIfNeeded()
            }
            .onChange(of: self.navigationRequest) { _, _ in
                self.applyNavigationRequestIfNeeded()
            }
        }
    }

    private var gatewayRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "antenna.radiowaves.left.and.right",
                color: self.gatewayStateColor)
            VStack(alignment: .leading, spacing: 2) {
                Text("Gateway")
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(.primary)
                Text(self.sidebarActiveAgentTitle)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                ProStatusDot(color: self.gatewayStateColor)
                Text(self.gatewayStateText)
                    .font(OpenClawType.footnoteSemiBold)
                    .foregroundStyle(self.gatewayStateColor)
                Image(systemName: "chevron.right")
                    .font(OpenClawType.captionSemiBold)
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
                        .font(OpenClawType.captionSemiBold)
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
        Label {
            Text(destination.title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.primary)
        } icon: {
            ProIconBadge(systemName: destination.systemImage, color: .secondary)
        }
    }

    @ViewBuilder
    private func detail(for destination: RootTabs.SidebarDestination) -> some View {
        switch destination {
        case .chat, .talk, .agents:
            EmptyView()
        case .gateway:
            SettingsProTab(directRoute: .gateway)
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                usesNativeNavigationChrome: true,
                headerTitle: "Overview",
                showsHeaderMark: false,
                openChat: { self.openChatFromControlDetail(.overview) },
                openSettings: { self.openGatewayDetail() },
                openSessions: { self.navigationPath.append(.sessions) })
        case .activity:
            IPadActivityScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.activity) },
                openSettings: { self.openGatewayDetail() })
        case .workboard:
            IPadWorkboardScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.workboard) },
                openSettings: { self.openGatewayDetail() })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                usesNativeNavigationChrome: true,
                openSettings: { self.openGatewayDetail() })
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerTitle: "Instances",
                openSettings: { self.openGatewayDetail() })
        case .sessions:
            CommandSessionsScreen(
                usesNativeNavigationChrome: true,
                openChat: { self.openChatFromControlDetail(.sessions) })
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerTitle: "Dreaming",
                openSettings: { self.openGatewayDetail() })
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerTitle: "Usage",
                openSettings: { self.openGatewayDetail() })
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerTitle: "Cron Jobs",
                openSettings: { self.openGatewayDetail() })
        case .docs:
            OpenClawDocsScreen(
                usesNativeNavigationChrome: true,
                gatewayAction: { self.openGatewayDetail() })
        case .settings:
            EmptyView()
        }
    }

    /// Gateway settings open as a pushed detail on this stack so Back returns
    /// to the hub screen the user came from, not the canonical Settings tab.
    private func openGatewayDetail() {
        self.navigationPath.append(.gateway)
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
        self.applyDestination(initialDestination)
    }

    private func applyNavigationRequestIfNeeded() {
        guard let navigationRequest, navigationRequest.id != self.handledNavigationRequestID else { return }
        self.handledNavigationRequestID = navigationRequest.id
        switch navigationRequest.target {
        case .root:
            self.navigationPath.removeAll()
        case let .detail(destination):
            self.applyDestination(destination)
        }
    }

    private func applyDestination(_ destination: RootTabs.SidebarDestination) {
        if self.opensRootTab(destination) {
            self.openPhoneRootDestination(destination)
        } else {
            self.navigationPath = [destination]
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
            navigationRequest: nil,
            openRootDestination: { _ in },
            openChatFromControlDetail: { _ in })
            .environment(appModel)
    }
}
#endif
