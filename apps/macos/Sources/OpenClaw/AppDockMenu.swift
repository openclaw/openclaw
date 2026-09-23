import AppKit

@MainActor
final class AppDockMenu: NSObject {
    private let openDashboard: () -> Void
    private let openGateway: (DashboardGatewayTarget) -> Void
    private let openSettings: () -> Void

    init(
        openDashboard: @escaping () -> Void,
        openGateway: @escaping (DashboardGatewayTarget) -> Void,
        openSettings: @escaping () -> Void)
    {
        self.openDashboard = openDashboard
        self.openGateway = openGateway
        self.openSettings = openSettings
    }

    func menu(entries: [DashboardGatewayEntry], selectedTarget: DashboardGatewayTarget?) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(self.item("Open Dashboard", symbol: "gauge", action: #selector(self.showDashboard)))
        let gateways = DashboardGatewayMenuModel.items(from: entries)
        if gateways.count > 1 {
            menu.addItem(.separator())
            for gateway in gateways {
                let item = self.item(
                    gateway.name,
                    symbol: gateway.isPrimary ? "house" : "server.rack",
                    action: #selector(self.showGateway(_:)))
                item.representedObject = gateway.target.bridgeID
                item.state = selectedTarget == gateway.target ? .on : .off
                menu.addItem(item)
            }
        }
        menu.addItem(.separator())
        menu.addItem(self.item("Settings…", symbol: "gearshape", action: #selector(self.showSettings)))
        return menu
    }

    private func item(_ title: String, symbol: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        return item
    }

    @objc private func showDashboard() {
        self.openDashboard()
    }

    @objc private func showSettings() {
        self.openSettings()
    }

    @objc private func showGateway(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String,
              let target = DashboardGatewayTarget(bridgeID: id) else { return }
        self.openGateway(target)
    }
}
