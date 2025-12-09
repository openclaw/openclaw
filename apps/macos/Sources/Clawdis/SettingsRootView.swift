import SwiftUI

struct SettingsRootView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general
    let updater: UpdaterProviding?

    var body: some View {
        TabView(selection: self.$selectedTab) {
            GeneralSettings(state: self.state)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)

            VoiceWakeSettings(state: self.state)
                .tabItem { Label("Voice Wake", systemImage: "waveform.circle") }
                .tag(SettingsTab.voiceWake)

            ConfigSettings()
                .tabItem { Label("Config", systemImage: "slider.horizontal.3") }
                .tag(SettingsTab.config)

            InstancesSettings()
                .tabItem { Label("Instances", systemImage: "network") }
                .tag(SettingsTab.instances)

            PermissionsSettings(
                status: self.permissionMonitor.status,
                refresh: self.refreshPerms,
                showOnboarding: { OnboardingController.shared.show() })
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
                .tag(SettingsTab.permissions)

            SessionsSettings()
                .tabItem { Label("Sessions", systemImage: "clock.arrow.circlepath") }
                .tag(SettingsTab.sessions)

            ToolsSettings()
                .tabItem { Label("Tools", systemImage: "wrench.and.screwdriver") }
                .tag(SettingsTab.tools)

            if self.state.debugPaneEnabled {
                DebugSettings()
                    .tabItem { Label("Debug", systemImage: "ant") }
                    .tag(SettingsTab.debug)
            }

            AboutSettings(updater: self.updater)
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag(SettingsTab.about)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 22)
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .clawdisSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.selectedTab = tab
                }
            }
        }
        .onAppear {
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
            self.updatePermissionMonitoring(for: newValue)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task { await self.refreshPerms() }
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug, !self.state.debugPaneEnabled { return .general }
        return requested
    }

    @MainActor
    private func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    private func updatePermissionMonitoring(for tab: SettingsTab) {
        let shouldMonitor = tab == .permissions
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }
}

enum SettingsTab: CaseIterable {
    case general, tools, sessions, config, instances, voiceWake, permissions, debug, about
    static let windowWidth: CGFloat = 598 // +15%
    static let windowHeight: CGFloat = 718 // +15%
    var title: String {
        switch self {
        case .general: "General"
        case .tools: "Tools"
        case .sessions: "Sessions"
        case .config: "Config"
        case .instances: "Instances"
        case .voiceWake: "Voice Wake"
        case .permissions: "Permissions"
        case .debug: "Debug"
        case .about: "About"
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
    static let clawdisSelectSettingsTab = Notification.Name("clawdisSelectSettingsTab")
}
