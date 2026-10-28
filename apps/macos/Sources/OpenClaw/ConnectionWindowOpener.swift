import Observation
import SwiftUI

enum ConnectionTab: CaseIterable, Hashable {
    case connection
    case gateways
    case debug
    case about

    static func available(debugEnabled: Bool) -> [Self] {
        debugEnabled ? [.connection, .gateways, .debug, .about] : [.connection, .gateways, .about]
    }
}

@MainActor
@Observable
final class ConnectionWindowOpener {
    static let shared = ConnectionWindowOpener()

    var selectedTab: ConnectionTab = .connection
    private var openWindowAction: (@MainActor () -> Void)?
    private var backgroundWindow: NSWindow?

    func openInBackground(state: AppState) {
        if self.backgroundWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(
                rootView: ConnectionWindow(state: state).environment(TailscaleService.shared)))
            window.title = "Connection"
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.center()
            self.backgroundWindow = window
        }
        AppActivation.shared.makeKeyAndOrderFront(window: self.backgroundWindow)
    }

    func register(openWindow: @escaping @MainActor () -> Void) {
        self.openWindowAction = openWindow
    }

    func open(tab: ConnectionTab = .connection, debugEnabled: Bool) {
        guard ConnectionTab.available(debugEnabled: debugEnabled).contains(tab) else { return }
        self.selectedTab = tab
        self.openWindowAction?()
    }
}
