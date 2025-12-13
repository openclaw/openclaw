import AppKit
import SwiftUI

@MainActor
final class MenuContextCardInjector: NSObject, NSMenuDelegate {
    static let shared = MenuContextCardInjector()

    private let tag = 9_415_227
    private let fallbackCardWidth: CGFloat = 320
    private weak var originalDelegate: NSMenuDelegate?
    private var loadTask: Task<Void, Never>?
    private var warmTask: Task<Void, Never>?
    private var cachedRows: [SessionRow] = []
    private var cacheErrorText: String?
    private var cacheUpdatedAt: Date?
    private let activeWindowSeconds: TimeInterval = 24 * 60 * 60
    private let refreshIntervalSeconds: TimeInterval = 15
    private var isMenuOpen = false

    func install(into statusItem: NSStatusItem) {
        // SwiftUI owns the menu, but we can inject a custom NSMenuItem.view right before display.
        guard let menu = statusItem.menu else { return }
        // Preserve SwiftUI's internal NSMenuDelegate, otherwise it may stop populating menu items.
        if menu.delegate !== self {
            self.originalDelegate = menu.delegate
            menu.delegate = self
        }

        if self.warmTask == nil {
            self.warmTask = Task { await self.refreshCache(force: true) }
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        self.originalDelegate?.menuWillOpen?(menu)
        self.isMenuOpen = true

        // Remove any previous injected card items.
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findInsertIndex(in: menu) else { return }

        self.loadTask?.cancel()

        let initialRows = self.cachedRows
        let initialIsLoading = initialRows.isEmpty
        let initialStatusText = initialIsLoading ? self.cacheErrorText : nil

        let initial = AnyView(ContextMenuCardView(
            rows: initialRows,
            statusText: initialStatusText,
            isLoading: initialIsLoading))

        let hosting = NSHostingView(rootView: initial)
        let size = hosting.fittingSize
        hosting.frame = NSRect(
            origin: .zero,
            size: NSSize(width: self.initialCardWidth(for: menu), height: size.height))

        let item = NSMenuItem()
        item.tag = self.tag
        item.view = hosting
        item.isEnabled = false

        menu.insertItem(item, at: insertIndex)

        // After the menu attaches the view to its window, adopt the menu's computed width.
        DispatchQueue.main.async { [weak self, weak hosting] in
            guard let self, let hosting else { return }
            self.adoptMenuWidthIfAvailable(for: menu, hosting: hosting)
        }

        if initialIsLoading {
            self.loadTask = Task { [weak hosting] in
                await self.refreshCache(force: true)
                guard let hosting else { return }
                let view = self.cachedView()
                await MainActor.run {
                    hosting.rootView = view
                    hosting.invalidateIntrinsicContentSize()
                    self.adoptMenuWidthIfAvailable(for: menu, hosting: hosting)
                    let size = hosting.fittingSize
                    hosting.frame.size.height = size.height
                }
            }
        } else {
            // Keep the menu stable while it's open; refresh in the background for next open.
            self.loadTask = Task { await self.refreshCache(force: false) }
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        self.originalDelegate?.menuDidClose?(menu)
        self.isMenuOpen = false
        self.loadTask?.cancel()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        self.originalDelegate?.menuNeedsUpdate?(menu)
    }

    func confinementRect(for menu: NSMenu, on screen: NSScreen?) -> NSRect {
        if let rect = self.originalDelegate?.confinementRect?(for: menu, on: screen) {
            return rect
        }
        return NSRect.zero
    }

    private func refreshCache(force: Bool) async {
        if !force, let cacheUpdatedAt, Date().timeIntervalSince(cacheUpdatedAt) < self.refreshIntervalSeconds {
            return
        }

        do {
            let rows = try await self.loadCurrentRows()
            self.cachedRows = rows
            self.cacheErrorText = nil
            self.cacheUpdatedAt = Date()
        } catch {
            if self.cachedRows.isEmpty {
                self.cacheErrorText = "Could not load sessions"
            }
            self.cacheUpdatedAt = Date()
        }
    }

    private func cachedView() -> AnyView {
        let rows = self.cachedRows
        let isLoading = rows.isEmpty && self.cacheErrorText == nil
        return AnyView(ContextMenuCardView(rows: rows, statusText: self.cacheErrorText, isLoading: isLoading))
    }

    private func loadCurrentRows() async throws -> [SessionRow] {
        let hints = SessionLoader.configHints()
        let store = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens)

        let loaded = try await SessionLoader.loadRows(at: store, defaults: defaults)
        let now = Date()
        let current = loaded.filter { row in
            if row.key == "main" { return true }
            guard let updatedAt = row.updatedAt else { return false }
            return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
        }

        return current.sorted { lhs, rhs in
            if lhs.key == "main" { return true }
            if rhs.key == "main" { return false }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }
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

    private func initialCardWidth(for menu: NSMenu) -> CGFloat {
        let width = menu.minimumWidth
        if width > 0 { return max(300, width) }
        return 300
    }

    private func adoptMenuWidthIfAvailable(for menu: NSMenu, hosting: NSHostingView<AnyView>) {
        let targetWidth: CGFloat? = {
            if let contentWidth = hosting.window?.contentView?.bounds.width, contentWidth > 0 { return contentWidth }
            if let superWidth = hosting.superview?.bounds.width, superWidth > 0 { return superWidth }
            let minimumWidth = menu.minimumWidth
            if minimumWidth > 0 { return minimumWidth }
            return nil
        }()

        guard let targetWidth else {
            if hosting.frame.width <= 0 {
                hosting.frame.size.width = self.fallbackCardWidth
            }
            return
        }

        let clamped = max(300, targetWidth)
        if abs(hosting.frame.width - clamped) < 1 { return }
        hosting.frame.size.width = clamped
    }
}
