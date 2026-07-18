import OpenClawProtocol
import SwiftUI

struct ReferencePhoneShell<Activity: View, Assistant: View, Settings: View>: View {
    @Binding var selection: RootTabs.AppTab
    let pendingApprovalCount: Int
    @ViewBuilder let activity: Activity
    @ViewBuilder let assistant: Assistant
    @ViewBuilder let settings: Settings

    var body: some View {
        ZStack(alignment: .bottom) {
            ZStack {
                self.tabSurface(self.activity, isSelected: self.normalizedSelection == .control)
                self.tabSurface(self.assistant, isSelected: self.normalizedSelection == .chat)
                self.tabSurface(self.settings, isSelected: self.normalizedSelection == .settings)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            ReferenceFloatingTabBar(
                selection: self.$selection,
                pendingApprovalCount: self.pendingApprovalCount)
                .padding(.bottom, 8)
        }
        .background(Color(uiColor: .systemBackground))
        .statusBarHidden(false)
    }

    private var normalizedSelection: RootTabs.AppTab {
        self.selection == .agent ? .control : self.selection
    }

    private func tabSurface(_ view: some View, isSelected: Bool) -> some View {
        view
            .padding(.bottom, 58)
            .opacity(isSelected ? 1 : 0)
            .allowsHitTesting(isSelected)
            .accessibilityHidden(!isSelected)
            .zIndex(isSelected ? 1 : 0)
    }
}

private struct ReferenceFloatingTabBar: View {
    @Binding var selection: RootTabs.AppTab
    let pendingApprovalCount: Int

    var body: some View {
        HStack(spacing: 4) {
            self.item(
                tab: .control,
                title: "Activity",
                systemImage: "waveform.path.ecg",
                badgeCount: self.pendingApprovalCount)
            self.item(tab: .chat, title: "Assistant", systemImage: "ellipsis.message")
            self.item(tab: .settings, title: "Settings", systemImage: "gearshape")
        }
        .padding(5)
        .background(Color.black.opacity(0.58), in: Capsule())
        .overlay { Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5) }
        .shadow(color: .black.opacity(0.22), radius: 12, y: 5)
        .accessibilityIdentifier("reference-phone-tab-bar")
    }

    private func item(
        tab: RootTabs.AppTab,
        title: LocalizedStringKey,
        systemImage: String,
        badgeCount: Int = 0) -> some View
    {
        let selected = self.normalizedSelection == tab
        return Button {
            self.selection = tab
        } label: {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Color.white : Color.white.opacity(0.52))
                .frame(width: 44, height: 40)
                .background(selected ? Color.white.opacity(0.18) : Color.clear, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if badgeCount > 0 {
                        Text(badgeCount > 99 ? "99+" : badgeCount.formatted())
                            .font(OpenClawType.caption2SemiBold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 16, minHeight: 16)
                            .background(OpenClawBrand.statusError, in: Capsule())
                            .offset(x: 3, y: -3)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue("\(badgeCount) pending approvals")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var normalizedSelection: RootTabs.AppTab {
        self.selection == .agent ? .control : self.selection
    }
}

struct ReferenceActivityTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var showsBackgroundTasks = false
    let pendingApprovalCount: Int
    let openDestination: (RootTabs.SidebarDestination) -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    self.gatewayHero
                    self.agentsSection
                    self.recentTasksSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
            .scrollIndicators(.hidden)
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
        }
        .statusBarHidden(false)
        .sheet(isPresented: self.$showsBackgroundTasks) {
            BackgroundTasksScreen(agentID: self.primaryAgentID)
        }
        .accessibilityIdentifier("reference-activity-screen")
    }

    private var gatewayHero: some View {
        VStack(spacing: 7) {
            ReferenceAppIcon(size: 42)
            HStack(spacing: 6) {
                Text(self.activeAgentName)
                    .font(OpenClawType.headline)
                ReferenceStatusPill(title: self.isConnected ? "Online" : "Offline", isOnline: self.isConnected)
            }
            Text("OpenClaw gateway")
                .font(OpenClawType.body)
                .foregroundStyle(.secondary)
            Button("Manage") { self.openDestination(.gateway) }
                .font(OpenClawType.subheadSemiBold)
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .frame(minHeight: 36)
                .background(Color(uiColor: .systemBackground), in: Capsule())
                .overlay { Capsule().stroke(Color(uiColor: .separator).opacity(0.42)) }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 10)
    }

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 5) {
                Text("Agents")
                    .font(OpenClawType.headline)
                Text("(\(self.agentRows.count))")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
                if self.pendingApprovalCount > 0 {
                    Text("\(self.pendingApprovalCount) approvals")
                        .font(OpenClawType.caption2SemiBold)
                        .foregroundStyle(OpenClawBrand.statusWarning)
                }
            }

            VStack(spacing: 0) {
                ForEach(Array(self.agentRows.enumerated()), id: \.element.id) { index, agent in
                    Button {
                        self.openDestination(.agents)
                    } label: {
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(self.agentName(agent))
                                        .font(OpenClawType.subheadSemiBold)
                                        .foregroundStyle(.primary)
                                    if index == 0 {
                                        ReferenceStatusPill(
                                            title: self.isConnected ? "Online" : "Offline",
                                            isOnline: self.isConnected)
                                    }
                                }
                                Text(index == 0 ? "Primary agent" : "Available agent")
                                    .font(OpenClawType.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if index > 0 {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 60)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < self.agentRows.count - 1 {
                        Divider().padding(.leading, 14)
                    }
                }
            }
            .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: .separator).opacity(0.3)) }

            HStack(spacing: 10) {
                ReferenceOutlineButton(title: "Refresh", systemImage: "arrow.clockwise") {
                    Task { await self.appModel.refreshGatewayOverviewIfConnected() }
                }
                ReferenceOutlineButton(title: "See all agents", systemImage: nil) {
                    self.openDestination(.agents)
                }
            }
        }
    }

    private var recentTasksSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Recent tasks")
                .font(OpenClawType.headline)
            VStack(spacing: 0) {
                if self.appModel.isScreenshotFixtureModeEnabled {
                    ReferenceTaskRow(
                        title: "Rename branch + push",
                        subtitle: "In-progress  1 min ago",
                        systemImage: "progress.indicator",
                        color: .blue)
                    Divider().padding(.leading, 48)
                    ReferenceTaskRow(
                        title: "Summarize server logs",
                        subtitle: "Completed  4 min ago",
                        systemImage: "checkmark.circle",
                        color: OpenClawBrand.statusSuccess)
                    Divider().padding(.leading, 48)
                    ReferenceTaskRow(
                        title: "Summarize what changed",
                        subtitle: "Queued",
                        systemImage: "circle.dotted",
                        color: .secondary)
                } else {
                    Button {
                        self.showsBackgroundTasks = true
                    } label: {
                        ReferenceTaskRow(
                            title: "View background tasks",
                            subtitle: "Live task history from the gateway",
                            systemImage: "clock.arrow.circlepath",
                            color: OpenClawBrand.info)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(Color(uiColor: .separator).opacity(0.3)) }
        }
    }

    private var agentRows: [AgentSummary] {
        let agents = self.appModel.gatewayAgents
        if agents.isEmpty {
            return []
        }
        let order = ["molty": 0, "automation": 1, "research": 2]
        let sorted = agents.sorted { lhs, rhs in
            let lhsName = self.agentName(lhs).lowercased()
            let rhsName = self.agentName(rhs).lowercased()
            return (order[lhsName] ?? 99, lhsName) < (order[rhsName] ?? 99, rhsName)
        }
        guard let defaultID = self.appModel.gatewayDefaultAgentId,
              let primary = agents.first(where: { $0.id == defaultID })
        else {
            return Array(sorted.prefix(3))
        }
        return Array(([primary] + sorted.filter { $0.id != primary.id }).prefix(3))
    }

    private var activeAgentName: String {
        let name = self.agentRows.first?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? "\(name!) (Main)" : "Main"
    }

    private var primaryAgentID: String {
        self.agentRows.first?.id ?? self.appModel.gatewayDefaultAgentId ?? "main"
    }

    private func agentName(_ agent: AgentSummary) -> String {
        let name = agent.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        return name?.isEmpty == false ? name! : agent.id
    }

    private var isConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }
}

private struct ReferenceStatusPill: View {
    let title: String
    let isOnline: Bool

    var body: some View {
        HStack(spacing: 3) {
            if self.isOnline {
                Circle().fill(OpenClawBrand.statusSuccess).frame(width: 5, height: 5)
            }
            Text(verbatim: self.title)
                .font(OpenClawType.caption2SemiBold)
        }
        .foregroundStyle(self.color)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            self.color.opacity(0.12),
            in: Capsule())
    }

    private var color: Color {
        if self.isOnline { return OpenClawBrand.statusSuccess }
        return self.title == "Offline" ? OpenClawBrand.statusError : OpenClawBrand.info
    }
}

private struct ReferenceOutlineButton: View {
    let title: LocalizedStringKey
    let systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(self.title).font(OpenClawType.subheadSemiBold)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .background(Color(uiColor: .systemBackground), in: Capsule())
        .overlay { Capsule().stroke(Color(uiColor: .separator).opacity(0.42)) }
    }
}

private struct ReferenceTaskRow: View {
    let title: LocalizedStringKey
    let subtitle: LocalizedStringKey
    let systemImage: String
    let color: Color

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(self.color)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title).font(OpenClawType.subheadSemiBold)
                Text(self.subtitle).font(OpenClawType.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 60)
    }
}

struct ReferenceSplashView: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 1, green: 0.02, blue: 0.10), Color(red: 1, green: 0, blue: 0.05)],
                startPoint: .top,
                endPoint: .bottom)
                .ignoresSafeArea()
            RadialGradient(
                colors: [Color.white.opacity(0.28), Color.clear],
                center: .center,
                startRadius: 0,
                endRadius: 170)
                .ignoresSafeArea()
            Text("OpenClaw")
                .font(OpenClawType.body)
                .foregroundStyle(.white)
                .scaleEffect(2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("OpenClaw")
        .accessibilityIdentifier("reference-splash-screen")
    }
}

struct ReferencePairingView: View {
    let scan: () -> Void
    let manual: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 7) {
                ReferenceAppIcon(size: 48)
                HStack(spacing: 6) {
                    Text("Main").font(OpenClawType.headline)
                    ReferenceStatusPill(title: "Offline", isOnline: false)
                }
                Text("OpenClaw gateway")
                    .font(OpenClawType.body)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 26)

            Text("Connect your machine to get started")
                .font(OpenClawType.body)
                .foregroundStyle(.secondary)
                .padding(.bottom, 12)

            HStack(spacing: 12) {
                self.action(title: "Scan QR", systemImage: "barcode.viewfinder", action: self.scan)
                self.action(title: "Set up manually", systemImage: "desktopcomputer", action: self.manual)
            }
            .padding(.horizontal, 16)

            Spacer()

            Link("What can OpenClaw do?", destination: URL(string: "https://docs.openclaw.ai")!)
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .padding(.bottom, 22)
        }
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("reference-pairing-screen")
    }

    private func action(title: LocalizedStringKey, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 11) {
                Image(systemName: systemImage)
                    .font(.system(size: 23, weight: .regular))
                Text(title).font(OpenClawType.subheadSemiBold)
            }
            .foregroundStyle(.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 148)
            .background(Color(uiColor: .systemBackground), in: Circle())
            .overlay { Circle().stroke(Color(uiColor: .separator).opacity(0.42)) }
        }
        .buttonStyle(.plain)
    }
}

struct ReferenceAppIcon: View {
    let size: CGFloat

    var body: some View {
        Image("ReferenceOpenClawIcon")
            .resizable()
            .scaledToFill()
            .frame(width: self.size, height: self.size)
            .clipShape(RoundedRectangle(cornerRadius: self.size * 0.22, style: .continuous))
            .accessibilityLabel("OpenClaw")
    }
}
