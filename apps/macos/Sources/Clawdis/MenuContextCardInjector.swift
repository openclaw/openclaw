import AppKit
import SwiftUI

@MainActor
final class MenuContextCardInjector: NSObject, NSMenuDelegate {
    static let shared = MenuContextCardInjector()

    private let tag = 9_415_227
    private let cardWidth: CGFloat = 320

    func install(into statusItem: NSStatusItem) {
        // SwiftUI owns the menu, but we can inject a custom NSMenuItem.view right before display.
        statusItem.menu?.delegate = self
    }

    func menuWillOpen(_ menu: NSMenu) {
        // Remove any previous injected card items.
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findInsertIndex(in: menu) else { return }

        let cardView = ContextMenuCardView(width: self.cardWidth)
        let hosting = NSHostingView(rootView: cardView)
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: self.cardWidth, height: size.height))

        let item = NSMenuItem()
        item.tag = self.tag
        item.view = hosting
        item.isEnabled = false

        menu.insertItem(item, at: insertIndex)
    }

    private func findInsertIndex(in menu: NSMenu) -> Int? {
        // Prefer inserting before the "Send Heartbeats" toggle item.
        if let idx = menu.items.firstIndex(where: { $0.title == "Send Heartbeats" }) {
            return idx
        }
        // Fallback: insert after the first two rows (active toggle + status).
        if menu.items.count >= 2 { return 2 }
        return menu.items.count
    }
}

