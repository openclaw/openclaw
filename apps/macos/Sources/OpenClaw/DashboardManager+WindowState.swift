import AppKit
import Foundation

extension DashboardManager {
    var currentNativeStartupCredentials: DashboardNativeGatewayAuth.LegacyCredentials? {
        self.controller?.documentHost.legacyNativeCredentials
    }

    func immediateResolvedDashboardAuth(
        url: URL,
        endpoint: GatewayConnection.EndpointSnapshot) -> DashboardWindowAuth?
    {
        guard let controller = self.controller, controller.currentURL == url,
              controller.auth.usesNativeDevice,
              controller.documentHost.hasCurrentNativeStartupCredentials,
              controller.auth.token == endpoint.config.token,
              controller.auth.password == endpoint.config.password
        else { return nil }
        return controller.auth
    }

    /// Reopen restores the last focused Dashboard window instead of raising the main window over it.
    /// A closed main window is still reopened by an explicit presentation.
    var lastFocusedDashboardToReopen: DashboardWindowController? {
        guard let previous = self.lastFrontmostWindow?.windowController as? DashboardWindowController
        else { return nil }
        if previous.isHiddenForExperience { return previous }
        guard previous !== self.controller, previous.isWindowOpen, self.controller?.isWindowOpen == true
        else { return nil }
        return previous
    }

    func snapshot(for target: DashboardGatewayTarget) -> DashboardGatewaySnapshot? {
        guard !self.gatewayEntries.isEmpty else { return nil }
        return DashboardGatewaySnapshot(gateways: self.gatewayEntries, currentId: target.bridgeID)
    }

    func target(for source: DashboardWindowController) -> DashboardGatewayTarget? {
        if self.controller === source {
            return self.mainTarget
        }
        return self.auxiliaryWindows.values.first { $0.controller === source }?.target
    }

    func controller(in window: NSWindow, for target: DashboardGatewayTarget) -> DashboardWindowController? {
        guard let controller = window.windowController as? DashboardWindowController,
              self.target(for: controller) == target else { return nil }
        return controller
    }

    func availableAutosaveName(
        for target: DashboardGatewayTarget,
        replacing source: DashboardWindowController? = nil) -> String
    {
        let base = self.autosaveName(for: target)
        let mainOwnsTarget = self.controller !== source && self.mainTarget == target
        let auxiliaryOwnsTarget = self.auxiliaryWindows.values.contains {
            $0.controller !== source && $0.target == target
        }
        return mainOwnsTarget || auxiliaryOwnsTarget ? "\(base)-\(UUID().uuidString)" : base
    }

    func dashboardControllers() -> [(target: DashboardGatewayTarget, controller: DashboardWindowController)] {
        var result: [(DashboardGatewayTarget, DashboardWindowController)] = []
        if let controller, controller.hasRetainedWindow {
            result.append((self.mainTarget, controller))
        }
        result += self.auxiliaryWindowOrder.compactMap { windowID in
            guard let instance = self.auxiliaryWindows[windowID],
                  instance.controller.hasRetainedWindow else { return nil }
            return (instance.target, instance.controller)
        }
        return result
    }

    func openWindowCount(for target: DashboardGatewayTarget) -> Int {
        // A launch preload nobody has opened is not a window the user has.
        self.dashboardControllers().count(where: { $0.target == target && !$0.controller.isUnshownPreload })
    }

    func dashboardController(for target: DashboardGatewayTarget) -> DashboardWindowController? {
        if let frontmost = frontmostDashboard(), frontmost.target == target {
            return frontmost.controller
        }
        if self.mainTarget == target, let controller, controller.hasRetainedWindow {
            return controller
        }
        return self.auxiliaryWindowOrder.reversed().lazy
            .compactMap { self.auxiliaryWindows[$0] }
            .first { $0.target == target && $0.controller.hasRetainedWindow }?
            .controller
    }
}
