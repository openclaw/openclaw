import AppKit
import OpenClawKit

@MainActor
enum AppNavigationActions {
    private(set) static var presentationGeneration: UInt64 = 0

    static var selectedGatewayTarget: DashboardGatewayTarget? {
        AppStateStore.shared.nativeExperienceEnabled
            ? WebChatManager.shared.frontmostGatewayTarget
            : DashboardManager.shared.frontmostDashboardTarget
    }

    static func openDashboard(userGesture: Bool = true) {
        if AppStateStore.shared.nativeExperienceEnabled {
            self.openGateway(self.selectedGatewayTarget ?? MacGatewaySelectionPreferences.shared.target)
        } else {
            DashboardManager.shared.presentDashboard(userGesture: userGesture)
        }
    }

    static func experienceDidChange(nativeEnabled: Bool) {
        self.presentationGeneration &+= 1
        let target: DashboardGatewayTarget?
        let wasVisible: Bool
        if nativeEnabled {
            target = DashboardManager.shared.frontmostDashboardTarget
            wasVisible = DashboardManager.shared.hasVisibleWindows
            DashboardManager.shared.hideWindows()
        } else {
            target = WebChatManager.shared.frontmostGatewayTarget
            wasVisible = WebChatManager.shared.hasVisibleWindows
            WebChatManager.shared.hideWindows()
        }
        if wasVisible { self.openGateway(target ?? MacGatewaySelectionPreferences.shared.target) }
    }

    @discardableResult
    static func openGateway(_ target: DashboardGatewayTarget, newWindow: Bool = false) -> Task<Void, Never> {
        if AppStateStore.shared.nativeExperienceEnabled {
            return WebChatManager.shared.openGatewayWindow(for: target, newWindow: newWindow)
        }
        return newWindow
            ? DashboardManager.shared.openNewDashboardWindow(for: target)
            : DashboardManager.shared.openOrFocusDashboard(for: target)
    }

    static func openPrimaryWebRoute(_ path: String, search: String? = nil) {
        let generation = self.presentationGeneration
        Task {
            guard generation == self.presentationGeneration else { return }
            await DashboardManager.shared.show(atPath: path, search: search, target: .primary) {
                generation == self.presentationGeneration
            }
        }
    }

    /// Gateway-owned onboarding has no native equivalent.
    static func openDashboardOnboarding() {
        self.openPrimaryWebRoute(
            DashboardRouteMap.custodianPagePath,
            search: DashboardRouteMap.custodianOnboardingSearch)
    }

    static func openChat(sessionKey: String? = nil, agentID: String? = nil, draft: String? = nil) {
        NSApp.activate(ignoringOtherApps: true)
        if AppStateStore.shared.nativeExperienceEnabled {
            WebChatManager.shared.show(sessionKey: sessionKey, agentID: agentID, draft: draft)
            return
        }
        let generation = self.presentationGeneration
        let primary = AppStateStore.shared.primaryGatewaySnapshot()
        Task { @MainActor in
            let connection = GatewayConnection.shared
            var lease: GatewayConnection.ServerLease?
            let isCurrent: @MainActor () -> Bool = {
                generation == self.presentationGeneration && AppStateStore.shared.isCurrentPrimaryGateway(primary) &&
                    (lease.map { connection.serverLeaseMatchesCurrentState($0) } ?? true)
            }
            do {
                guard isCurrent() else { return }
                var path = sessionKey.flatMap { WebChatRoute.dashboardPath(sessionKey: $0, agentID: agentID) }
                if path == nil {
                    let sourceLease = try await connection.acquireServerLease()
                    lease = sourceLease
                    guard isCurrent() else { return }
                    let key: String = if let sessionKey {
                        sessionKey
                    } else {
                        try await connection.mainSessionKey(ifCurrentServerLease: sourceLease)
                    }
                    let defaults = await connection.lastSnapshot?.snapshot.sessiondefaults
                    path = WebChatRoute.dashboardPath(
                        sessionKey: key, agentID: agentID ?? (defaults?["defaultAgentId"]?.value as? String))
                }
                guard isCurrent() else { return }
                guard let path else { throw URLError(.badURL) }
                // Endpoint lookup may suspend again. Keep the originating primary
                // and any server-derived defaults fenced through actual draft dispatch.
                await DashboardManager.shared.show(
                    atPath: path,
                    search: WebChatRoute.dashboardSearch(draft: draft),
                    target: .primary,
                    ifCurrent: isCurrent)
            } catch {
                guard isCurrent(), !(error is CancellationError) else { return }
                let alert = NSAlert()
                alert.messageText = "Could Not Open Chat"
                alert.informativeText = "Connect to the Gateway, then select this conversation in the Dashboard."
                alert.runModal()
            }
        }
    }

    static func openSettings() {
        let target = self.selectedGatewayTarget ?? MacGatewaySelectionPreferences.shared.target
        Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.appearanceSettingsPath, target: target) }
    }

    static func openConnection(tab: ConnectionTab = .connection) {
        NSApp.activate(ignoringOtherApps: true)
        ConnectionWindowOpener.shared.open(tab: tab, debugEnabled: AppStateStore.shared.debugPaneEnabled)
    }

    static func openAbout() {
        let build = ArtifactBuildInfo(infoDictionary: Bundle.main.infoDictionary ?? [:])
        let credits = NSMutableAttributedString(string: String(localized:
            "Menu bar companion for notifications, screenshots, and privileged agent actions."))
        credits.append(NSAttributedString(string: "\n\n" + build.copyText + "\n\n"))
        for (title, address) in [
            (String(localized: "Website"), "https://openclaw.ai"),
            (String(localized: "Docs"), "https://docs.openclaw.ai"),
            (String(localized: "GitHub"), "https://github.com/openclaw/openclaw"),
            (String(localized: "Discord"), "https://discord.gg/clawd"),
        ] {
            credits.append(NSAttributedString(string: title + "\n", attributes: [.link: address]))
        }
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "OpenClaw",
            .applicationVersion: build.version,
            .version: build.build,
            .credits: credits,
            NSApplication.AboutPanelOptionKey(rawValue: "Copyright"):
                String(localized: "© 2026 OpenClaw Foundation — MIT License."),
        ])
    }
}
