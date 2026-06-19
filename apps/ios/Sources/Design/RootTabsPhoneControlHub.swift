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
                        ForEach(self.groups) { group in
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

    @ViewBuilder
    private var headerCard: some View {
        if self.isCompactHeight {
            ProCard(padding: 8, radius: OpenClawProMetric.cardRadius) {
                HStack(spacing: 12) {
                    OpenClawProMark(size: 24, shadowRadius: 3)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(self.sidebarActiveAgentTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text(self.gatewayDisplayLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(value: self.gatewayStateText, color: self.gatewayStateColor)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        } else {
            ProCard(radius: OpenClawProMetric.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        OpenClawProMark(size: 32, shadowRadius: 4)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(self.sidebarActiveAgentTitle)
                                .font(.headline)
                                .lineLimit(1)
                            Text(self.gatewayDisplayLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer(minLength: 8)
                        ProValuePill(value: self.gatewayStateText, color: self.gatewayStateColor)
                    }

                    self.gatewayActionRow
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var gatewayActionRow: some View {
        Button {
            self.openPhoneRootDestination(.gateway)
        } label: {
            HStack(spacing: 10) {
                ProStatusDot(color: self.gatewayStateColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.gatewayStateText)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(self.gatewayDisplayLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Text(self.gatewayActionTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OpenClawBrand.accent)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .padding(10)
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Gateway \(self.gatewayStateText)")
        .accessibilityHint("Opens Settings / Gateway")
    }

    private func groupSection(_ group: RootTabs.SidebarGroup) -> some View {
        VStack(alignment: .leading, spacing: self.isCompactHeight ? 6 : 8) {
            ProSectionHeader(title: group.title.capitalized)
            ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
                VStack(spacing: 0) {
                    ForEach(Array(group.destinations.enumerated()), id: \.element.id) { index, destination in
                        if index > 0 {
                            Divider().padding(.leading, 58)
                        }
                        self.destinationRow(destination)
                    }
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
        HStack(alignment: .center, spacing: 12) {
            ProIconBadge(systemName: destination.systemImage, color: self.color(for: destination))
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
        .padding(.vertical, self.isCompactHeight ? 8 : 10)
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
                openSettings: { self.openPhoneRootDestination(.gateway) })
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

    private var gatewayActionTitle: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            "Manage"
        case .connecting:
            "Details"
        case .error:
            "Fix"
        case .disconnected:
            "Connect"
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
        case .chat, .talk, .overview, .gateway:
            OpenClawBrand.accent
        case .instances:
            Color.secondary
        case .activity, .usage, .docs:
            OpenClawBrand.accentHot
        case .agents, .workboard, .skillWorkshop, .sessions, .dreaming, .cron, .settings:
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
