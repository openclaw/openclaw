import AppKit
import SwiftUI

struct SettingsToolbarCleaner: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let toolbar = nsView.window?.toolbar else { return }
            toolbar.items.removeAll {
                $0.itemIdentifier == .toggleSidebar
                    || $0.itemIdentifier.rawValue == "com.apple.NSToolbarShowSidebarItem"
            }
        }
    }
}
