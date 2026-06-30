import OpenClawProtocol
import SwiftUI

struct RootTabsPhoneControlHub: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var navigationPath: [RootTabs.SidebarDestination] = []
    @State private var didApplyInitialDestination = false

    let groups: [RootTabs.SidebarGroup]
    let initialDestination: RootTabs.SidebarDestination?
    let openRootDestination: (RootTabs.SidebarDestination) -> Void

    var body: some View {
        NavigationStack(path: self.$navigationPath) {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: self.isCompactHeight ? 10 : 16) {
                        self.headerCard
                        self.chatTalkRow
                        ForEach(self.controlGroups) { group in
                            self.groupSection(group)
                        }
                        self.versionFooter
                    }
                    .padding(.vertical, self.isCompactHeight ? 10 : 16)
                }
                .safeAreaPadding(.bottom, self.bottomScrollInset)
            }
            .navigationTitle("Control")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: RootTabs.SidebarDestination.self) { destination in
                self.detail(for: destination)
                    .navigationBarBackButtonHidden(true)
                    .toolbar(.hidden, for: .navigationBar)
            }
            .onAppear {
                self.applyInitialDestinationIfNeeded()
            }
        }
    }

    private var headerCard: some View {
        let avatarSize: CGFloat = self.isCompactHeight ? 36 : 52
        return HStack(alignment: .center, spacing: 12) {
            OpenClawProMark(size: avatarSize, shadowRadius: avatarSize / 9)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.gatewayDisplayLabel)
                    .font(.title3.weight(.bold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 4) {
                    Text(self.sidebarActiveAgentTitle)
                    Text("•")
                    Text(self.gatewayStateText)
                        .foregroundStyle(self.gatewayStateColor)
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button {
                self.openPhoneRootDestination(.gateway)
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                    .background(Color.primary.opacity(0.06), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Gateway \(self.gatewayStateText)")
            .accessibilityHint("Opens Settings / Gateway")
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var controlGroups: [RootTabs.SidebarGroup] {
        self.groups.filter { !$0.destinations.contains(.chat) }
    }

    private var chatTalkRow: some View {
        HStack(alignment: .top, spacing: 12) {
            self.bigDestinationCard(.chat)
            self.bigDestinationCard(.talk)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func bigDestinationCard(_ destination: RootTabs.SidebarDestination) -> some View {
        Button {
            self.openPhoneRootDestination(destination)
        } label: {
            ProCard(padding: 18, radius: OpenClawProMetric.cardRadius) {
                VStack(alignment: .leading, spacing: 14) {
                    ControlCircleIcon(
                        systemName: destination.systemImage,
                        color: self.color(for: destination),
                        size: 50)
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(destination.title)
                                .font(.headline)
                                .foregroundStyle(.primary)
                            Text(destination.subtitle)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func groupSection(_ group: RootTabs.SidebarGroup) -> some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                ForEach(Array(group.destinations.enumerated()), id: \.element.id) { index, destination in
                    if index > 0 {
                        Divider().padding(.leading, 70)
                    }
                    self.destinationRow(destination)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private func destinationRow(_ destination: RootTabs.SidebarDestination) -> some View {
        if self.opensRootTab(destination) {
            Button {
                self.openPhoneRootDestination(destination)
            } label: {
                self.rowLabel(destination)
            }
            .buttonStyle(.plain)
        } else {
            Button {
                self.navigationPath.append(destination)
            } label: {
                self.rowLabel(destination)
            }
            .buttonStyle(.plain)
        }
    }

    private func rowLabel(_ destination: RootTabs.SidebarDestination) -> some View {
        HStack(alignment: .center, spacing: 14) {
            ControlCircleIcon(systemName: destination.systemImage, color: self.color(for: destination), size: 42)
            VStack(alignment: .leading, spacing: 3) {
                Text(destination.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(destination.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, self.isCompactHeight ? 12 : 16)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
    }

    private var versionFooter: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            HStack {
                Spacer()
                Text("v\(DeviceInfoHelper.openClawVersionString())")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer()
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private func detail(for destination: RootTabs.SidebarDestination) -> some View {
        switch destination {
        case .chat, .talk, .agents, .gateway:
            EmptyView()
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                headerTitle: "Overview",
                headerLeadingAction: self.phoneDetailBackAction,
                showsHeaderMark: false,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) },
                openSessions: { self.navigationPath.append(.sessions) })
        case .activity:
            IPadActivityScreen(
                headerLeadingAction: self.phoneDetailBackAction,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .workboard:
            IPadWorkboardScreen(
                headerLeadingAction: self.phoneDetailBackAction,
                openChat: { self.openPhoneRootDestination(.chat) },
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                headerLeadingAction: self.phoneDetailBackAction,
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerLeadingAction: self.phoneDetailBackAction,
                headerTitle: "Instances",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .sessions:
            CommandSessionsScreen(
                headerLeadingAction: self.phoneDetailBackAction,
                openChat: { self.openPhoneRootDestination(.chat) })
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerLeadingAction: self.phoneDetailBackAction,
                headerTitle: "Dreaming",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerLeadingAction: self.phoneDetailBackAction,
                headerTitle: "Usage",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerLeadingAction: self.phoneDetailBackAction,
                headerTitle: "Cron Jobs",
                openSettings: { self.openPhoneRootDestination(.gateway) })
        case .docs:
            OpenClawDocsScreen(
                headerLeadingAction: self.phoneDetailBackAction,
                gatewayAction: { self.openPhoneRootDestination(.gateway) })
        case .settings:
            EmptyView()
        }
    }

    private var phoneDetailBackAction: OpenClawSidebarHeaderAction {
        OpenClawSidebarHeaderAction(
            systemName: "chevron.left",
            accessibilityLabel: "Back to Control",
            accessibilityIdentifier: "OpenClawPhoneDetailBackButton",
            action: { self.popPhoneDetail() })
    }

    private func popPhoneDetail() {
        guard !self.navigationPath.isEmpty else { return }
        self.navigationPath.removeLast()
    }

    private func openPhoneRootDestination(_ destination: RootTabs.SidebarDestination) {
        self.navigationPath.removeAll()
        self.openRootDestination(destination)
    }

    private func opensRootTab(_ destination: RootTabs.SidebarDestination) -> Bool {
        RootTabs.shouldOpenRootTabFromPhoneHub(destination)
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

    private var gatewayDisplayLabel: String {
        self.normalized(self.appModel.gatewayServerName)
            ?? self.normalized(self.appModel.gatewayRemoteAddress)
            ?? self.appModel.gatewayDisplayStatusText
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

    private var isCompactHeight: Bool {
        self.verticalSizeClass == .compact
    }

    private var bottomScrollInset: CGFloat {
        Self.bottomScrollInset(verticalSizeClass: self.verticalSizeClass)
    }

    static func bottomScrollInset(verticalSizeClass: UserInterfaceSizeClass?) -> CGFloat {
        verticalSizeClass == .compact ? 72 : 112
    }

    private func color(for destination: RootTabs.SidebarDestination) -> Color {
        switch destination {
        case .chat:
            OpenClawBrand.ok
        case .talk, .skillWorkshop:
            OpenClawBrand.info
        case .overview:
            OpenClawBrand.warn
        case .activity:
            OpenClawBrand.accent
        case .workboard:
            .purple
        case .instances, .sessions, .dreaming:
            Color.secondary
        case .usage, .docs:
            OpenClawBrand.accentHot
        case .agents, .cron, .settings, .gateway:
            OpenClawBrand.ok
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

private struct ControlCircleIcon: View {
    let systemName: String
    let color: Color
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: self.size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: self.size, height: self.size)
            .background(
                LinearGradient(
                    colors: [self.color.opacity(0.72), self.color],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing),
                in: Circle())
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
