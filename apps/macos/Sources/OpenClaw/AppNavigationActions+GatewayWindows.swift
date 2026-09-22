import AppKit

extension AppNavigationActions {
    static func newGatewayWindow() {
        let generation = self.presentationGeneration
        Task { @MainActor in
            do {
                let entries = try await DashboardGatewayCatalog.loadEntries()
                guard generation == self.presentationGeneration else { return }
                guard !entries.isEmpty else {
                    AppNavigationActions.openConnection()
                    return
                }
                let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 28), pullsDown: false)
                popup.addItems(withTitles: entries.map(\.name))
                let preferredID = MacGatewaySelectionPreferences.shared.target.bridgeID
                popup.selectItem(at: entries.firstIndex { $0.id == preferredID } ?? 0)

                let alert = NSAlert()
                alert.messageText = "New Gateway Window"
                alert.informativeText = "Choose a Gateway. Each window uses the experience selected in Settings."
                alert.accessoryView = popup
                alert.addButton(withTitle: "Open Window")
                alert.addButton(withTitle: "Manage Gateways…")
                alert.addButton(withTitle: "Cancel")
                switch alert.runModal() {
                case .alertFirstButtonReturn:
                    guard generation == self.presentationGeneration,
                          entries.indices.contains(popup.indexOfSelectedItem),
                          let target = DashboardGatewayTarget(bridgeID: entries[popup.indexOfSelectedItem].id)
                    else { return }
                    self.openGateway(target, newWindow: true)
                case .alertSecondButtonReturn:
                    AppNavigationActions.openConnection(tab: .gateways)
                default:
                    break
                }
            } catch {
                guard generation == self.presentationGeneration else { return }
                let alert = NSAlert(error: error)
                alert.messageText = "Could Not Open Gateway Window"
                alert.runModal()
            }
        }
    }
}
