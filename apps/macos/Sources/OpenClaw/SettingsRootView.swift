import AppKit
import Observation
import SwiftUI

struct SettingsRootView: View {
    @Bindable var state: AppState
    private let permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general
    @State private var splitViewVisibility: NavigationSplitViewVisibility = .all
    @State private var snapshotPaths: (configPath: String?, stateDir: String?) = (nil, nil)
    let updater: UpdaterProviding?
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode

    init(state: AppState, updater: UpdaterProviding?, initialTab: SettingsTab? = nil) {
        self.state = state
        self.updater = updater
        self._selectedTab = State(initialValue: initialTab ?? .general)
    }

    var body: some View {
        NavigationSplitView(columnVisibility: self.$splitViewVisibility) {
            List(selection: self.sidebarSelection) {
                ForEach(self.availableTabs, id: \.self) { tab in
                    Label(tab.title, systemImage: tab.systemImage)
                        .tag(tab)
                }
            }
            .navigationSplitViewColumnWidth(min: 210, ideal: 220, max: 240)
            .listStyle(.sidebar)
        } detail: {
            VStack(alignment: .leading, spacing: 12) {
                if self.isNixMode {
                    self.nixManagedBanner
                }
                self.detailContent
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .navigationTitle(self.selectedTab.title)
        }
        .navigationSplitViewStyle(.balanced)
        .frame(
            minWidth: SettingsTab.minWindowWidth,
            idealWidth: SettingsTab.windowWidth,
            maxWidth: .infinity,
            minHeight: SettingsTab.minWindowHeight,
            idealHeight: SettingsTab.windowHeight,
            maxHeight: .infinity,
            alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .openclawSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.splitViewVisibility = .all
                    self.selectedTab = tab
                }
            }
        }
        .onAppear {
            self.splitViewVisibility = .all
            if let pending = SettingsTabRouter.consumePending() {
                self.selectedTab = self.validTab(for: pending)
            }
            self.updatePermissionMonitoring(for: self.selectedTab)
        }
        .onChange(of: self.state.debugPaneEnabled) { _, enabled in
            if !enabled, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.selectedTab) { _, newValue in
            self.splitViewVisibility = .all
            self.updatePermissionMonitoring(for: newValue)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            guard self.selectedTab == .permissions else { return }
            Task { await self.refreshPerms() }
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task {
            guard !self.isPreview else { return }
            await self.refreshPerms()
        }
        .task(id: self.state.connectionMode) {
            guard !self.isPreview else { return }
            await self.refreshSnapshotPaths()
        }
    }

    private var availableTabs: [SettingsTab] {
        var tabs: [SettingsTab] = [
            .general,
            .channels,
            .voiceWake,
            .config,
            .instances,
            .sessions,
            .cron,
            .skills,
            .permissions,
        ]
        if self.state.debugPaneEnabled {
            tabs.append(.debug)
        }
        tabs.append(.about)
        return tabs
    }

    private var sidebarSelection: Binding<SettingsTab?> {
        Binding<SettingsTab?>(
            get: { self.selectedTab },
            set: { newValue in
                guard let newValue else { return }
                self.selectedTab = newValue
            })
    }

    @ViewBuilder
    private var detailContent: some View {
        switch self.selectedTab {
        case .general:
            GeneralSettings(state: self.state)
        case .channels:
            ChannelsSettings()
        case .voiceWake:
            VoiceWakeSettings(state: self.state, isActive: true)
        case .config:
            ConfigSettings()
        case .instances:
            InstancesSettings()
        case .sessions:
            SessionsSettings()
        case .cron:
            CronSettings()
        case .skills:
            SkillsSettings(state: self.state)
        case .permissions:
            PermissionsSettings(
                status: self.permissionMonitor.status,
                refresh: self.refreshPerms,
                showOnboarding: { DebugActions.restartOnboarding() })
        case .debug:
            DebugSettings(state: self.state)
        case .about:
            AboutSettings(updater: self.updater)
        }
    }

    private var nixManagedBanner: some View {
        // Prefer gateway-resolved paths; fall back to local env defaults if disconnected.
        let configPath = self.snapshotPaths.configPath ?? OpenClawPaths.configURL.path
        let stateDir = self.snapshotPaths.stateDir ?? OpenClawPaths.stateDirURL.path

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "gearshape.2.fill")
                    .foregroundStyle(.secondary)
                Text("Managed by Nix")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("Config: \(configPath)")
                Text("State:  \(stateDir)")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(Color.gray.opacity(0.12))
        .cornerRadius(10)
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug, !self.state.debugPaneEnabled { return .general }
        return requested
    }

    @MainActor
    private func refreshSnapshotPaths() async {
        let paths = await GatewayConnection.shared.snapshotPaths()
        self.snapshotPaths = paths
    }

    @MainActor
    private func refreshPerms() async {
        guard !self.isPreview else { return }
        await self.permissionMonitor.refreshNow()
    }

    private func updatePermissionMonitoring(for tab: SettingsTab) {
        guard !self.isPreview else { return }
        PermissionMonitoringSupport.setMonitoring(tab == .permissions, monitoring: &self.monitoringPermissions)
    }

    private func stopPermissionMonitoring() {
        PermissionMonitoringSupport.stopMonitoring(&self.monitoringPermissions)
    }
}

enum SettingsTab: CaseIterable {
    case general, channels, skills, sessions, cron, config, instances, voiceWake, permissions, debug, about
    static let minWindowWidth: CGFloat = 1_040
    static let minWindowHeight: CGFloat = 580
    static let windowWidth: CGFloat = 1_160
    static let windowHeight: CGFloat = 720
    var title: String {
        switch self {
        case .general: "General"
        case .channels: "Channels"
        case .skills: "Skills"
        case .sessions: "Sessions"
        case .cron: "Cron"
        case .config: "Config"
        case .instances: "Instances"
        case .voiceWake: "Voice Wake"
        case .permissions: "Permissions"
        case .debug: "Debug"
        case .about: "About"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .channels: "link"
        case .skills: "sparkles"
        case .sessions: "clock.arrow.circlepath"
        case .cron: "calendar"
        case .config: "slider.horizontal.3"
        case .instances: "network"
        case .voiceWake: "waveform.circle"
        case .permissions: "lock.shield"
        case .debug: "ant"
        case .about: "info.circle"
        }
    }

    static func launchArgument(from arguments: [String]) -> SettingsTab? {
        if let inline = arguments.first(where: { $0.hasPrefix("--settings-tab=") }) {
            return self.init(tabLaunchArgument: String(inline.dropFirst("--settings-tab=".count)))
        }

        if let index = arguments.firstIndex(of: "--settings-tab") {
            let nextIndex = arguments.index(after: index)
            if nextIndex < arguments.endIndex {
                return self.init(tabLaunchArgument: arguments[nextIndex])
            }
        }

        if arguments.contains("--settings") {
            return .general
        }

        return nil
    }

    init?(tabLaunchArgument rawValue: String) {
        switch rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
        {
        case "general":
            self = .general
        case "channels":
            self = .channels
        case "skills":
            self = .skills
        case "sessions":
            self = .sessions
        case "cron":
            self = .cron
        case "config":
            self = .config
        case "instances":
            self = .instances
        case "voice-wake", "voicewake":
            self = .voiceWake
        case "permissions":
            self = .permissions
        case "debug":
            self = .debug
        case "about":
            self = .about
        default:
            return nil
        }
    }
}

@MainActor
enum SettingsTabRouter {
    private static var pending: SettingsTab?

    static func request(_ tab: SettingsTab) {
        self.pending = tab
    }

    static func consumePending() -> SettingsTab? {
        defer { self.pending = nil }
        return self.pending
    }
}

extension Notification.Name {
    static let openclawSelectSettingsTab = Notification.Name("openclawSelectSettingsTab")
}

#if DEBUG
struct SettingsRootView_Previews: PreviewProvider {
    static var previews: some View {
        ForEach(SettingsTab.allCases, id: \.self) { tab in
            SettingsRootView(state: .preview, updater: DisabledUpdaterController(), initialTab: tab)
                .previewDisplayName(tab.title)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        }
    }
}
#endif
