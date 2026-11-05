import AppKit
import WebKit

final class DashboardWebView: WKWebView {
    static let contentZoomDefaultsKey = "openclaw.contentZoom"
    var onContentZoomChanged: (() -> Void)?
    var canAdoptLegacyTextScale: () -> Bool = { false }

    private enum ContentZoomInitialization {
        case waitingForLegacyScale
        case pending(Double)
        case finished
    }

    private var contentZoomInitialization = ContentZoomInitialization.waitingForLegacyScale

    func restoreContentZoom() {
        guard let saved = AppDefaults.standard.object(forKey: Self.contentZoomDefaultsKey) as? Double else { return }
        self.pageZoom = Self.boundedContentZoom(saved)
        self.contentZoomInitialization = .finished
    }

    func offerLegacyTextScale(_ percent: Double) {
        if case .finished = self.contentZoomInitialization { return }
        self.contentZoomInitialization = .pending(percent / 100)
        if self.window?.isKeyWindow == true { self.finishContentZoomInitialization() }
    }

    /// The first foreground window supplies the old, document-local choice.
    /// Background preloads cannot choose the profile's new shared default.
    func finishContentZoomInitialization() {
        if case .finished = self.contentZoomInitialization { return }
        guard self.canAdoptLegacyTextScale() else { return }
        if let saved = AppDefaults.standard.object(forKey: Self.contentZoomDefaultsKey) as? Double {
            self.setContentZoom(saved)
        } else if case let .pending(zoom) = self.contentZoomInitialization {
            self.setContentZoom(zoom)
        }
    }

    func changeContentZoom(by steps: Int) {
        self.setContentZoom((self.pageZoom * 100).rounded() / 100 + Double(steps) / 10)
    }

    func setContentZoom(_ zoom: Double) {
        self.contentZoomInitialization = .finished
        self.pageZoom = Self.boundedContentZoom(zoom)
        AppDefaults.standard.set(Double(self.pageZoom), forKey: Self.contentZoomDefaultsKey)
        self.onContentZoomChanged?()
    }

    static func boundedContentZoom(_ zoom: Double) -> Double {
        zoom.isFinite && zoom > 0 ? min(2, max(0.5, zoom)) : 1
    }

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

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        let items = Self.filteredContextMenuItems(menu.items)
        menu.removeAllItems()
        for item in items {
            menu.addItem(item)
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
