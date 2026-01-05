import AppKit
import SwiftUI

struct SettingsToolbarCleaner: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let toolbar = nsView.window?.toolbar else { return }
            let items = toolbar.items
            for (index, item) in items.enumerated().reversed() {
                let isSidebarToggle =
                    item.itemIdentifier == .toggleSidebar
                        || item.itemIdentifier.rawValue == "com.apple.NSToolbarShowSidebarItem"
                if isSidebarToggle {
                    toolbar.removeItem(at: index)
                }
            }
        }
    }
}
