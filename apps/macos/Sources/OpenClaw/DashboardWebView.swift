import AppKit
import WebKit

final class DashboardWebView: WKWebView {
    /// Receives clipboard images that WebKit would drop from a paste; nil keeps WebKit's paste.
    var onUnreadableImagePaste: (@MainActor ([Data]) -> Void)?
    /// The pasteboard checked for those images. WebKit's own paste always reads the general
    /// pasteboard; tests use a private one.
    var imagePasteboard = NSPasteboard.general

    private static let pasteMenuItemIdentifier = "WKMenuItemIdentifierPaste"
    private static let hiddenContextMenuIdentifiers: Set<String> = [
        "WKMenuItemIdentifierReload",
        "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow",
        "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierDownloadLinkedFile",
        "WKMenuItemIdentifierDownloadImage",
        "WKMenuItemIdentifierDownloadMedia",
    ]

    /// WKWebView implements `paste:` without declaring it to Swift, so this method replaces it
    /// through the Objective-C runtime and calls WebKit's implementation for every other paste.
    /// WebKit picks its editing command from the selector, so that call must pass `paste:`.
    @objc func paste(_ sender: Any?) {
        if let onUnreadableImagePaste = self.onUnreadableImagePaste,
           let images = DashboardPastedImages.unreadableImages(in: self.imagePasteboard.pasteboardItems ?? [])
        {
            onUnreadableImagePaste(images)
            return
        }
        let selector = #selector(NSText.paste(_:))
        guard let webKitPaste = class_getInstanceMethod(WKWebView.self, selector) else { return }
        typealias Paste = @convention(c) (WKWebView, Selector, Any?) -> Void
        unsafeBitCast(method_getImplementation(webKitPaste), to: Paste.self)(self, selector, sender)
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let items = Self.filteredContextMenuItems(menu.items)
        Self.routePasteMenuItems(items, to: self)
        menu.removeAllItems()
        for item in items {
            menu.addItem(item)
        }
    }

    /// WebKit's own Paste menu item pastes inside the page without calling `paste:`. WebKit's
    /// context menus do not auto-enable items, so the item keeps WebKit's enabled state.
    private static func routePasteMenuItems(_ items: [NSMenuItem], to target: AnyObject) {
        for item in items where item.identifier?.rawValue == self.pasteMenuItemIdentifier {
            item.target = target
            item.action = #selector(DashboardWebView.paste(_:))
        }
    }

    static func filteredContextMenuItems(_ items: [NSMenuItem]) -> [NSMenuItem] {
        var filtered: [NSMenuItem] = []
        for item in items where !Self.hiddenContextMenuIdentifiers.contains(item.identifier?.rawValue ?? "") {
            if item.isSeparatorItem, filtered.last?.isSeparatorItem != false {
                continue
            }
            filtered.append(item)
        }
        if filtered.last?.isSeparatorItem == true {
            filtered.removeLast()
        }
        return filtered
    }
}
