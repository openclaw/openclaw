import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Adapts the existing menu catalog; the window's admitted target owns every route.
struct MacSidebarIdentityMenu: ViewModifier {
    let target: DashboardGatewayTarget?
    let healthy: Bool

    func body(content: Content) -> some View {
        let gateways = DashboardGatewayMenuModel.items(from: DashboardManager.shared.gatewayEntries)
        let current = gateways.first { $0.target == self.target }
        content.environment(
            \.openClawSidebarIdentityMenu,
            OpenClawSidebarIdentityMenu(
                gatewayName: current?.name,
                isPrimary: current?.isPrimary == true)
            {
                if let target = self.target {
                    Section("Gateway") {
                        ForEach(gateways) { gateway in
                            Toggle(isOn: Binding(
                                get: { gateway.target == target },
                                set: { selected in
                                    if selected { AppNavigationActions.openGateway(gateway.target) }
                                })) {
                                    Label {
                                        Text(verbatim: gateway.isPrimary
                                            ? gateway.name + " · " + String(localized: "Primary") : gateway.name)
                                    } icon: {
                                        Image(systemName: "circle.fill")
                                            .foregroundStyle(self.healthColor(gateway, current: target))
                                    }
                                }
                        }
                        if current?.canPromote == true {
                            Button("Set as primary…") { DashboardManager.shared.confirmSetPrimary(target) }
                        }
                        Button("Manage Gateways…") { AppNavigationActions.openConnection(tab: .gateways) }
                    }
                    Section {
                        Button("Open Dashboard") { self.openRoute("/", target: target) }
                        Button("Settings…") { self.openRoute(DashboardRouteMap.appearanceSettingsPath, target: target) }
                        Button("Usage") { self.openRoute(DashboardRouteMap.usagePagePath, target: target) }
                    }
                }
                Button("About OpenClaw") { AppNavigationActions.openAbout() }
            })
            .task(id: self.target) {
                guard self.target != nil else { return }
                // Native-only startup need not have opened the Dashboard or its Gateways menu yet.
                await DashboardManager.shared.refreshGatewaySnapshots()
            }
    }

    private func healthColor(_ gateway: DashboardGatewayMenuItem, current: DashboardGatewayTarget) -> Color {
        // The active window owns its health; other rows use the menu catalog's cached facts.
        let health = gateway.target == current ? (self.healthy ? .ok : .error) : gateway.health
        return switch health {
        case .ok: .green
        case .error: .orange
        case .unknown: .secondary
        }
    }

    private func openRoute(_ path: String, target: DashboardGatewayTarget) {
        Task { await DashboardManager.shared.show(atPath: path, target: target) }
    }
}
