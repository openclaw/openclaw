import AppKit
import SwiftUI

@MainActor
final class MenuSessionsInjector: NSObject, NSMenuDelegate {
    static let shared = MenuSessionsInjector()

    private let tag = 9_415_557
    private let fallbackWidth: CGFloat = 320
    private let activeWindowSeconds: TimeInterval = 24 * 60 * 60

    private weak var originalDelegate: NSMenuDelegate?
    private weak var statusItem: NSStatusItem?
    private var loadTask: Task<Void, Never>?
    private var isMenuOpen = false
    private var lastKnownMenuWidth: CGFloat?

    private var cachedSnapshot: SessionStoreSnapshot?
    private var cachedErrorText: String?
    private var cacheUpdatedAt: Date?
    private let refreshIntervalSeconds: TimeInterval = 12

    func install(into statusItem: NSStatusItem) {
        self.statusItem = statusItem
        guard let menu = statusItem.menu else { return }

        // Preserve SwiftUI's internal NSMenuDelegate, otherwise it may stop populating menu items.
        if menu.delegate !== self {
            self.originalDelegate = menu.delegate
            menu.delegate = self
        }

        if self.loadTask == nil {
            self.loadTask = Task { await self.refreshCache(force: true) }
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        self.originalDelegate?.menuWillOpen?(menu)
        self.isMenuOpen = true

        self.inject(into: menu)

        // Refresh in background for the next open (but only when connected).
        self.loadTask?.cancel()
        self.loadTask = Task { [weak self] in
            guard let self else { return }
            await self.refreshCache(force: false)
            await MainActor.run {
                guard self.isMenuOpen else { return }
                // SwiftUI might have refreshed menu items; re-inject once.
                self.inject(into: menu)
            }
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

    // MARK: - Injection

    private func inject(into menu: NSMenu) {
        // Remove any previous injected items.
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findInsertIndex(in: menu) else { return }
        let width = self.initialWidth(for: menu)

        guard self.isControlChannelConnected else {
            menu.insertItem(self.makeMessageItem(
                text: "No connection to gateway",
                symbolName: "wifi.slash",
                width: width), at: insertIndex)
            return
        }

        guard let snapshot = self.cachedSnapshot else {
            let headerItem = NSMenuItem()
            headerItem.tag = self.tag
            headerItem.isEnabled = false
            headerItem.view = self.makeHostedView(
                rootView: AnyView(MenuSessionsHeaderView(
                    count: 0,
                    statusText: self.cachedErrorText ?? "Loading sessions…")),
                width: width,
                highlighted: false)
            menu.insertItem(headerItem, at: insertIndex)
            DispatchQueue.main.async { [weak self, weak view = headerItem.view] in
                guard let self, let view else { return }
                self.captureMenuWidthIfAvailable(from: view)
            }
            return
        }

        let now = Date()
        let rows = snapshot.rows.filter { row in
            if row.key == "main" { return true }
            guard let updatedAt = row.updatedAt else { return false }
            return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
        }.sorted { lhs, rhs in
            if lhs.key == "main" { return true }
            if rhs.key == "main" { return false }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }

        let headerItem = NSMenuItem()
        headerItem.tag = self.tag
        headerItem.isEnabled = false
        let headerView = self.makeHostedView(
            rootView: AnyView(MenuSessionsHeaderView(count: rows.count, statusText: nil)),
            width: width,
            highlighted: false)
        headerItem.view = headerView
        menu.insertItem(headerItem, at: insertIndex)

        var cursor = insertIndex + 1
        if rows.isEmpty {
            menu.insertItem(self.makeMessageItem(text: "No active sessions", symbolName: "minus", width: width), at: cursor)
            return
        }

        for row in rows {
            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = true
            item.submenu = self.buildSubmenu(for: row, storePath: snapshot.storePath)
            item.view = self.makeHostedView(
                rootView: AnyView(SessionMenuLabelView(row: row, width: width)),
                width: width,
                highlighted: true)
            menu.insertItem(item, at: cursor)
            cursor += 1
        }

        DispatchQueue.main.async { [weak self, weak headerView] in
            guard let self, let headerView else { return }
            self.captureMenuWidthIfAvailable(from: headerView)
        }
    }

    private var isControlChannelConnected: Bool {
        if case .connected = ControlChannel.shared.state { return true }
        return false
    }

    private func makeMessageItem(text: String, symbolName: String, width: CGFloat) -> NSMenuItem {
        let view = AnyView(
            Label(text, systemImage: symbolName)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.leading, 18)
                .padding(.trailing, 12)
                .padding(.vertical, 6)
                .frame(minWidth: 300, alignment: .leading))

        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = false
        item.view = self.makeHostedView(rootView: view, width: width, highlighted: false)
        return item
    }

    // MARK: - Cache

    private func refreshCache(force: Bool) async {
        if !force, let updated = self.cacheUpdatedAt, Date().timeIntervalSince(updated) < self.refreshIntervalSeconds {
            return
        }

        guard self.isControlChannelConnected else {
            self.cachedSnapshot = nil
            self.cachedErrorText = nil
            self.cacheUpdatedAt = Date()
            return
        }

        do {
            self.cachedSnapshot = try await SessionLoader.loadSnapshot(limit: 32)
            self.cachedErrorText = nil
            self.cacheUpdatedAt = Date()
        } catch {
            self.cachedSnapshot = nil
            self.cachedErrorText = self.compactError(error)
            self.cacheUpdatedAt = Date()
        }
    }

    private func compactError(_ error: Error) -> String {
        if let loadError = error as? SessionLoadError {
            switch loadError {
            case .gatewayUnavailable:
                return "No connection to gateway"
            case .decodeFailed:
                return "Sessions unavailable"
            }
        }
        return "Sessions unavailable"
    }

    // MARK: - Submenus

    private func buildSubmenu(for row: SessionRow, storePath: String) -> NSMenu {
        let menu = NSMenu()

        let syncing = NSMenuItem(title: "Syncing", action: nil, keyEquivalent: "")
        syncing.submenu = self.buildSyncingMenu(for: row)
        menu.addItem(syncing)

        let thinking = NSMenuItem(title: "Thinking", action: nil, keyEquivalent: "")
        thinking.submenu = self.buildThinkingMenu(for: row)
        menu.addItem(thinking)

        let verbose = NSMenuItem(title: "Verbose", action: nil, keyEquivalent: "")
        verbose.submenu = self.buildVerboseMenu(for: row)
        menu.addItem(verbose)

        if AppStateStore.shared.debugPaneEnabled,
           AppStateStore.shared.connectionMode == .local,
           let sessionId = row.sessionId,
           !sessionId.isEmpty
        {
            menu.addItem(NSMenuItem.separator())
            let openLog = NSMenuItem(title: "Open Session Log", action: #selector(self.openSessionLog(_:)), keyEquivalent: "")
            openLog.target = self
            openLog.representedObject = [
                "sessionId": sessionId,
                "storePath": storePath,
            ]
            menu.addItem(openLog)
        }

        menu.addItem(NSMenuItem.separator())

        let reset = NSMenuItem(title: "Reset Session", action: #selector(self.resetSession(_:)), keyEquivalent: "")
        reset.target = self
        reset.representedObject = row.key
        menu.addItem(reset)

        let compact = NSMenuItem(title: "Compact Session Log", action: #selector(self.compactSession(_:)), keyEquivalent: "")
        compact.target = self
        compact.representedObject = row.key
        menu.addItem(compact)

        if row.key != "main" {
            let del = NSMenuItem(title: "Delete Session", action: #selector(self.deleteSession(_:)), keyEquivalent: "")
            del.target = self
            del.representedObject = row.key
            del.isAlternate = false
            del.keyEquivalentModifierMask = []
            menu.addItem(del)
        }

        return menu
    }

    private func buildSyncingMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        let options: [(title: String, value: String?)] = [
            ("On", "on"),
            ("Off", "off"),
            ("Default", nil),
        ]
        for (title, value) in options {
            let item = NSMenuItem(title: title, action: #selector(self.patchSyncing(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": value as Any,
            ]
            let isSelected: Bool = {
                switch value {
                case .none:
                    return row.syncing == nil
                case "on":
                    return row.syncing?.isOn == true
                case "off":
                    return row.syncing?.isOff == true
                default:
                    return false
                }
            }()
            item.state = isSelected ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildThinkingMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        let levels: [String?] = ["off", "minimal", "low", "medium", "high", nil]
        for level in levels {
            let title = (level ?? "default").capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchThinking(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (row.thinkingLevel == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildVerboseMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        let levels: [String?] = ["on", "off", nil]
        for level in levels {
            let title = (level ?? "default").capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchVerbose(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (row.verboseLevel == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    @objc
    private func patchThinking(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: Any],
              let key = dict["key"] as? String
        else { return }
        let value = dict["value"] as? String
        Task {
            do {
                try await SessionActions.patchSession(key: key, thinking: .some(value))
                await self.refreshCache(force: true)
            } catch {
                await MainActor.run {
                    SessionActions.presentError(title: "Update thinking failed", error: error)
                }
            }
        }
    }

    @objc
    private func patchVerbose(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: Any],
              let key = dict["key"] as? String
        else { return }
        let value = dict["value"] as? String
        Task {
            do {
                try await SessionActions.patchSession(key: key, verbose: .some(value))
                await self.refreshCache(force: true)
            } catch {
                await MainActor.run {
                    SessionActions.presentError(title: "Update verbose failed", error: error)
                }
            }
        }
    }

    @objc
    private func patchSyncing(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: Any],
              let key = dict["key"] as? String
        else { return }

        let selection = dict["value"] as? String
        let value: SessionSyncingValue? = switch selection {
        case "on": .bool(true)
        case "off": .bool(false)
        default: nil
        }

        Task {
            do {
                try await SessionActions.patchSession(key: key, syncing: .some(value))
                await self.refreshCache(force: true)
            } catch {
                await MainActor.run {
                    SessionActions.presentError(title: "Update syncing failed", error: error)
                }
            }
        }
    }

    @objc
    private func openSessionLog(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: String],
              let sessionId = dict["sessionId"],
              let storePath = dict["storePath"]
        else { return }
        SessionActions.openSessionLogInCode(sessionId: sessionId, storePath: storePath)
    }

    @objc
    private func resetSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                title: "Reset session?",
                message: "Starts a new session id for “\(key)”.",
                action: "Reset")
            else { return }

            do {
                try await SessionActions.resetSession(key: key)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Reset failed", error: error)
            }
        }
    }

    @objc
    private func compactSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                title: "Compact session log?",
                message: "Keeps the last 400 lines; archives the old file.",
                action: "Compact")
            else { return }

            do {
                try await SessionActions.compactSession(key: key, maxLines: 400)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Compact failed", error: error)
            }
        }
    }

    @objc
    private func deleteSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                title: "Delete session?",
                message: "Deletes the “\(key)” entry and archives its transcript.",
                action: "Delete")
            else { return }

            do {
                try await SessionActions.deleteSession(key: key)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Delete failed", error: error)
            }
        }
    }

    // MARK: - Width + placement

    private func findInsertIndex(in menu: NSMenu) -> Int? {
        // Insert right before the separator above "Send Heartbeats".
        if let idx = menu.items.firstIndex(where: { $0.title == "Send Heartbeats" }) {
            if let sepIdx = menu.items[..<idx].lastIndex(where: { $0.isSeparatorItem }) {
                return sepIdx
            }
            return idx
        }

        if let sepIdx = menu.items.firstIndex(where: { $0.isSeparatorItem }) {
            return sepIdx
        }

        if menu.items.count >= 1 { return 1 }
        return menu.items.count
    }

    private func initialWidth(for menu: NSMenu) -> CGFloat {
        let candidates: [CGFloat] = [
            menu.minimumWidth,
            self.lastKnownMenuWidth ?? 0,
            self.fallbackWidth,
        ]
        let resolved = candidates.max() ?? self.fallbackWidth
        return max(300, resolved)
    }

    // MARK: - Views

    private func makeHostedView(rootView: AnyView, width: CGFloat, highlighted: Bool) -> NSView {
        if highlighted {
            let container = HighlightedMenuItemHostView(rootView: rootView, width: width)
            return container
        }

        let hosting = NSHostingView(rootView: rootView)
        hosting.frame.size.width = max(1, width)
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
        return hosting
    }

    private func captureMenuWidthIfAvailable(from view: NSView) {
        guard let width = view.window?.contentView?.bounds.width, width > 0 else { return }
        self.lastKnownMenuWidth = max(300, width)
    }
}

private final class HighlightedMenuItemHostView: NSView {
    private let baseView: AnyView
    private let hosting: NSHostingView<AnyView>
    private var tracking: NSTrackingArea?
    private var hovered = false {
        didSet { self.updateHighlight() }
    }

    init(rootView: AnyView, width: CGFloat) {
        self.baseView = rootView
        self.hosting = NSHostingView(rootView: AnyView(rootView.environment(\.menuItemHighlighted, false)))
        super.init(frame: .zero)

        self.addSubview(self.hosting)
        self.hosting.autoresizingMask = [.width, .height]
        self.hosting.frame = self.bounds

        self.frame.size.width = max(1, width)
        let size = self.fittingSize
        self.frame.size.height = size.height
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking {
            self.removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [
            .mouseEnteredAndExited,
            .activeAlways,
            .inVisibleRect,
        ]
        let area = NSTrackingArea(rect: self.bounds, options: options, owner: self, userInfo: nil)
        self.addTrackingArea(area)
        self.tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        _ = event
        self.hovered = true
    }

    override func mouseExited(with event: NSEvent) {
        _ = event
        self.hovered = false
    }

    override func layout() {
        super.layout()
        self.hosting.frame = self.bounds
    }

    override func draw(_ dirtyRect: NSRect) {
        if self.hovered {
            NSColor.selectedContentBackgroundColor.setFill()
            self.bounds.fill()
        }
        super.draw(dirtyRect)
    }

    private func updateHighlight() {
        self.hosting.rootView = AnyView(self.baseView.environment(\.menuItemHighlighted, self.hovered))
        self.needsDisplay = true
    }
}
