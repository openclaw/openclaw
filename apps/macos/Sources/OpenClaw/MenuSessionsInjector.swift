import AppKit
import Foundation
import Observation
import SwiftUI

@MainActor
final class MenuSessionsInjector: NSObject, NSMenuDelegate {
    static let shared = MenuSessionsInjector()

    private let tag = 9_415_557
    private let nodesTag = 9_415_558
    private let activeHeaderTag = 9_415_559
    private let quickSettingsTag = 9_415_561
    private let actionsTag = 9_415_562
    private let appLabelTag = 9_415_563
    private let nativeItemsTag = 9_415_564
    private let fallbackWidth: CGFloat = 320
    private let activeWindowSeconds: TimeInterval = 24 * 60 * 60

    private var quickSettingsBrowserControlEnabled: Bool = true
    private var quickSettingsHostedViews: [ClickableMenuItemHostView] = []
    private var execApprovalsHostedView: HighlightedMenuItemHostView?
    private var voiceWakePendingIsOn: Bool?
    private var activeHeaderHostedView: ClickableMenuItemHostView?

    private weak var originalDelegate: NSMenuDelegate?
    private weak var statusItem: NSStatusItem?
    private var loadTask: Task<Void, Never>?
    private var nodesLoadTask: Task<Void, Never>?
    private var previewTasks: [Task<Void, Never>] = []
    private var isMenuOpen = false
    private var lastKnownMenuWidth: CGFloat?
    private var menuOpenWidth: CGFloat?
    private var isObservingControlChannel = false

    private var cachedSnapshot: SessionStoreSnapshot?
    private var cachedErrorText: String?
    private var cacheUpdatedAt: Date?
    private let refreshIntervalSeconds: TimeInterval = 12
    private var cachedUsageSummary: GatewayUsageSummary?
    private var cachedUsageErrorText: String?
    private var usageCacheUpdatedAt: Date?
    private let usageRefreshIntervalSeconds: TimeInterval = 30
    private var cachedCostSummary: GatewayCostUsageSummary?
    private var cachedCostErrorText: String?
    private var costCacheUpdatedAt: Date?
    private let costRefreshIntervalSeconds: TimeInterval = 45
    private let nodesStore = NodesStore.shared
    #if DEBUG
    private var testControlChannelConnected: Bool?
    #endif

    func install(into statusItem: NSStatusItem) {
        self.statusItem = statusItem
        guard let menu = statusItem.menu else { return }

        // Lock in a minimum width so the menu never shrinks when injected
        // items change (e.g. gateway disconnect → reconnect).
        menu.minimumWidth = self.fallbackWidth

        // Preserve SwiftUI's internal NSMenuDelegate, otherwise it may stop populating menu items.
        if menu.delegate !== self {
            self.originalDelegate = menu.delegate
            menu.delegate = self
        }

        if self.loadTask == nil {
            self.loadTask = Task {
                await self.refreshCache(force: true)
                await self.refreshQuickSettingsBrowserControl()
            }
        }

        self.startControlChannelObservation()
        self.nodesStore.start()
    }

    func menuWillOpen(_ menu: NSMenu) {
        self.originalDelegate?.menuWillOpen?(menu)
        self.isMenuOpen = true
        self.menuOpenWidth = self.currentMenuWidth(for: menu)

        self.injectActiveHeader(into: menu)
        self.injectNodes(into: menu)
        self.inject(into: menu)
        self.injectQuickSettings(into: menu)
        self.injectActionsLabel(into: menu)
        self.injectAppLabel(into: menu)
        self.injectNativeItemViews(into: menu)

        // Refresh in background for the next open; keep width stable while open.
        self.loadTask?.cancel()
        let forceRefresh = self.cachedSnapshot == nil || self.cachedErrorText != nil
        self.loadTask = Task { [weak self] in
            guard let self else { return }
            await self.refreshCache(force: forceRefresh)
            await self.refreshUsageCache(force: forceRefresh)
            await self.refreshCostUsageCache(force: forceRefresh)
            await self.refreshQuickSettingsBrowserControl()
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.injectActiveHeader(into: menu)
                self.injectNodes(into: menu)
                self.inject(into: menu)
                self.injectQuickSettings(into: menu)
                self.injectActionsLabel(into: menu)
                self.injectAppLabel(into: menu)
                self.injectNativeItemViews(into: menu)
            }
        }

        self.nodesLoadTask?.cancel()
        self.nodesLoadTask = Task { [weak self] in
            guard let self else { return }
            await self.nodesStore.refresh()
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.injectNodes(into: menu)
            }
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        self.originalDelegate?.menuDidClose?(menu)
        self.isMenuOpen = false
        self.menuOpenWidth = nil
        self.loadTask?.cancel()
        self.nodesLoadTask?.cancel()
        self.cancelPreviewTasks()
    }

    private func startControlChannelObservation() {
        guard !self.isObservingControlChannel else { return }
        self.isObservingControlChannel = true
        self.observeControlChannelState()
    }

    private func observeControlChannelState() {
        withObservationTracking {
            _ = ControlChannel.shared.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.handleControlChannelStateChange()
                self.observeControlChannelState()
            }
        }
    }

    private func handleControlChannelStateChange() {
        guard self.isMenuOpen, let menu = self.statusItem?.menu else { return }
        self.loadTask?.cancel()
        self.loadTask = Task { [weak self, weak menu] in
            guard let self, let menu else { return }
            await self.refreshCache(force: true)
            await self.refreshUsageCache(force: true)
            await self.refreshCostUsageCache(force: true)
            await self.refreshQuickSettingsBrowserControl()
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.injectActiveHeader(into: menu)
                self.injectNodes(into: menu)
                self.inject(into: menu)
                self.injectQuickSettings(into: menu)
                self.injectActionsLabel(into: menu)
                self.injectAppLabel(into: menu)
                self.injectNativeItemViews(into: menu)
            }
        }

        self.nodesLoadTask?.cancel()
        self.nodesLoadTask = Task { [weak self, weak menu] in
            guard let self, let menu else { return }
            await self.nodesStore.refresh()
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.injectNodes(into: menu)
            }
        }
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
}

extension MenuSessionsInjector {
    // MARK: - Injection

    private var mainSessionKey: String {
        WorkActivityStore.shared.mainSessionKey
    }

    private func inject(into menu: NSMenu) {
        self.cancelPreviewTasks()
        // Remove any previous injected items.
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findInsertIndex(in: menu) else { return }
        let width = self.initialWidth(for: menu)
        let isConnected = self.isControlChannelConnected
        let channelState = ControlChannel.shared.state

        var cursor = insertIndex
        var headerView: NSView?

        // "Activity" section label wraps Context (sessions) + Usage together.
        let activityLabel = NSMenuItem()
        activityLabel.tag = self.tag
        activityLabel.isEnabled = false
        activityLabel.view = self.makeHostedView(
            rootView: AnyView(MenuSectionLabelView(title: "Activity", width: width)),
            width: width,
            highlighted: false)
        menu.insertItem(activityLabel, at: cursor)
        cursor += 1

        if let snapshot = self.cachedSnapshot {
            let now = Date()
            let mainKey = self.mainSessionKey
            let rows = snapshot.rows.filter { row in
                if row.key == "main", mainKey != "main" { return false }
                if row.key == mainKey { return true }
                guard let updatedAt = row.updatedAt else { return false }
                return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
            }.sorted { lhs, rhs in
                if lhs.key == mainKey { return true }
                if rhs.key == mainKey { return false }
                return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
            }
            if !rows.isEmpty {
                let previewKeys = rows.prefix(20).map(\.key)
                let task = Task {
                    await SessionMenuPreviewLoader.prewarm(sessionKeys: previewKeys, maxItems: 10)
                }
                self.previewTasks.append(task)
            }

            let headerItem = NSMenuItem()
            headerItem.tag = self.tag
            headerItem.isEnabled = false
            let statusText = self
                .cachedErrorText ?? (isConnected ? nil : self.controlChannelStatusText(for: channelState))
            let hosted = self.makeHostedView(
                rootView: AnyView(MenuSessionsHeaderView(
                    count: rows.count,
                    statusText: statusText)),
                width: width,
                highlighted: true)
            headerItem.view = hosted
            headerView = hosted
            menu.insertItem(headerItem, at: cursor)
            cursor += 1

            if rows.isEmpty {
                menu.insertItem(
                    self.makeMessageItem(text: "No active sessions", symbolName: "minus", width: width),
                    at: cursor)
                cursor += 1
            } else {
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
            }
        } else {
            let headerItem = NSMenuItem()
            headerItem.tag = self.tag
            headerItem.isEnabled = false
            let statusText = isConnected
                ? (self.cachedErrorText ?? "Loading sessions…")
                : self.controlChannelStatusText(for: channelState)
            let hosted = self.makeHostedView(
                rootView: AnyView(MenuSessionsHeaderView(
                    count: 0,
                    statusText: statusText)),
                width: width,
                highlighted: true)
            headerItem.view = hosted
            headerView = hosted
            menu.insertItem(headerItem, at: cursor)
            cursor += 1

            if !isConnected {
                menu.insertItem(
                    self.makeMessageItem(
                        text: "Connect the gateway to see sessions",
                        symbolName: "bolt.slash",
                        width: width),
                    at: cursor)
                cursor += 1
            }
        }

        cursor = self.insertUsageSection(into: menu, at: cursor, width: width)

        DispatchQueue.main.async { [weak self, weak headerView] in
            guard let self, let headerView else { return }
            self.captureMenuWidthIfAvailable(from: headerView)
        }
    }

    private func injectActiveHeader(into menu: NSMenu) {
        for item in menu.items where item.tag == self.activeHeaderTag {
            menu.removeItem(item)
        }
        self.activeHeaderHostedView = nil

        let width = self.initialWidth(for: menu)
        let state = AppStateStore.shared

        let hosted = ClickableMenuItemHostView(
            rootView: self.makeActiveHeaderView(state: state, width: width),
            width: width)
        hosted.showsHighlight = false
        self.activeHeaderHostedView = hosted
        hosted.onClick = { [weak self] in
            state.isPaused.toggle()
            // Update the existing view in place so SwiftUI can animate the toggle.
            guard let self else { return }
            self.refreshActiveHeader()
        }

        let item = NSMenuItem()
        item.tag = self.activeHeaderTag
        item.isEnabled = true
        item.view = hosted
        menu.insertItem(item, at: 0)

        let separator = NSMenuItem.separator()
        separator.tag = self.activeHeaderTag
        menu.insertItem(separator, at: 1)
    }

    private func makeActiveHeaderView(state: AppState, width: CGFloat) -> AnyView {
        AnyView(MenuActiveHeaderView(state: state, width: width))
    }

    private func refreshActiveHeader() {
        let w = self.currentWidth
        let state = AppStateStore.shared
        self.activeHeaderHostedView?.update(rootView: self.makeActiveHeaderView(state: state, width: w), width: w)
    }

    private func injectNodes(into menu: NSMenu) {
        for item in menu.items where item.tag == self.nodesTag {
            menu.removeItem(item)
        }

        // Status section is pinned right after the active header (positions 2+).
        var cursor = self.statusInsertIndex(in: menu)
        let width = self.initialWidth(for: menu)

        let entries = self.sortedNodeEntries()
        let deviceCount = entries.count
        let isConnecting = { if case .connecting = ControlChannel.shared.state { return true }; return false }()

        // "Status" section label
        let sectionLabel = NSMenuItem()
        sectionLabel.tag = self.nodesTag
        sectionLabel.isEnabled = false
        sectionLabel.view = self.makeHostedView(
            rootView: AnyView(MenuSectionLabelView(title: "Status", width: width)),
            width: width,
            highlighted: false)
        menu.insertItem(sectionLabel, at: cursor)
        cursor += 1

        // Gateway row — compact single line with status dot
        if let gatewayEntry = self.gatewayEntry() {
            let gatewayItem = self.makeGatewayItem(entry: gatewayEntry, width: width)
            menu.insertItem(gatewayItem, at: cursor)
            cursor += 1
        }

        // Connected Devices row with submenu
        let submenu = self.buildDevicesSubmenu(entries: entries, width: width)
        let devicesView = AnyView(ConnectedDevicesMenuRowView(
            count: deviceCount,
            isConnecting: isConnecting,
            isConnected: self.isControlChannelConnected,
            width: width))
        let devicesHosted = HighlightedMenuItemHostView(rootView: devicesView, width: width)

        let item = NSMenuItem()
        item.tag = self.nodesTag
        item.isEnabled = true
        item.view = devicesHosted
        item.submenu = submenu
        menu.insertItem(item, at: cursor)
        cursor += 1

        // Bottom separator separates Status from Activity section.
        let sep = NSMenuItem.separator()
        sep.tag = self.nodesTag
        menu.insertItem(sep, at: cursor)
    }

    // MARK: - Quick Settings injection

    private func injectQuickSettings(into menu: NSMenu) {
        for item in menu.items where item.tag == self.quickSettingsTag {
            menu.removeItem(item)
        }
        self.quickSettingsHostedViews = []
        self.execApprovalsHostedView = nil

        guard let insertIndex = self.findQuickSettingsInsertIndex(in: menu) else { return }
        let width = self.initialWidth(for: menu)
        var cursor = insertIndex

        // Separator before Quick Settings section.
        let sep = NSMenuItem.separator()
        sep.tag = self.quickSettingsTag
        menu.insertItem(sep, at: cursor)
        cursor += 1

        // "Quick Settings" section label.
        let sectionLabel = NSMenuItem()
        sectionLabel.tag = self.quickSettingsTag
        sectionLabel.isEnabled = false
        sectionLabel.view = self.makeHostedView(
            rootView: AnyView(MenuSectionLabelView(title: "Quick Settings", width: width)),
            width: width,
            highlighted: false)
        menu.insertItem(sectionLabel, at: cursor)
        cursor += 1

        let state = AppStateStore.shared

        // Send Heartbeats — index 0
        cursor = self.appendToggle(
            into: menu, at: cursor, width: width,
            icon: "waveform.path.ecg", label: "Send Heartbeats",
            isOn: state.heartbeatsEnabled) {
                state.heartbeatsEnabled.toggle()
            }

        // Browser Control — index 1
        cursor = self.appendToggle(
            into: menu, at: cursor, width: width,
            icon: "globe", label: "Browser Control",
            isOn: self.quickSettingsBrowserControlEnabled) { [weak self] in
                guard let self else { return }
                let newValue = !self.quickSettingsBrowserControlEnabled
                self.quickSettingsBrowserControlEnabled = newValue
                self.refreshQuickSettingsVisuals()
                Task {
                    var root = await ConfigStore.load()
                    var browser = root["browser"] as? [String: Any] ?? [:]
                    browser["enabled"] = newValue
                    root["browser"] = browser
                    do {
                        try await ConfigStore.save(root)
                    } catch {
                        await MainActor.run { [weak self] in
                            guard let self else { return }
                            self.quickSettingsBrowserControlEnabled = !newValue
                            self.refreshQuickSettingsVisuals()
                        }
                    }
                }
            }

        // Allow Camera — index 2
        cursor = self.appendToggle(
            into: menu, at: cursor, width: width,
            icon: "camera", label: "Allow Camera",
            isOn: UserDefaults.standard.bool(forKey: cameraEnabledKey)) {
                let current = UserDefaults.standard.bool(forKey: cameraEnabledKey)
                UserDefaults.standard.set(!current, forKey: cameraEnabledKey)
            }

        // Allow Canvas — index 3
        cursor = self.appendToggle(
            into: menu, at: cursor, width: width,
            icon: "rectangle.and.pencil.and.ellipsis", label: "Allow Canvas",
            isOn: state.canvasEnabled) {
                state.canvasEnabled.toggle()
                if !state.canvasEnabled {
                    CanvasManager.shared.hideAll()
                }
            }

        // Voice Wake — index 4
        let voiceWakeIsOn = self.voiceWakePendingIsOn ?? state.swabbleEnabled
        cursor = self.appendToggle(
            into: menu, at: cursor, width: width,
            icon: "mic.fill", label: "Voice Wake",
            isOn: voiceWakeIsOn) { [weak self] in
                guard let self else { return }
                let current = self.voiceWakePendingIsOn ?? state.swabbleEnabled
                let newValue = !current
                self.voiceWakePendingIsOn = newValue
                self.refreshQuickSettingsVisuals()
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    await state.setVoiceWakeEnabled(newValue)
                    self.voiceWakePendingIsOn = nil
                    self.refreshQuickSettingsVisuals()
                }
            }

        // Exec Approvals — submenu row (not a toggle), placed last
        let execView = AnyView(MenuSubMenuRow(
            icon: "terminal",
            label: "Exec Approvals",
            currentValue: state.execApprovalMode.title,
            width: width))
        let execHosted = HighlightedMenuItemHostView(rootView: execView, width: width)
        self.execApprovalsHostedView = execHosted
        let execItem = NSMenuItem()
        execItem.tag = self.quickSettingsTag
        execItem.isEnabled = true
        execItem.view = execHosted
        execItem.submenu = self.buildExecApprovalsSubmenu(state: state, width: width)
        menu.insertItem(execItem, at: cursor)
        cursor += 1
        _ = cursor
    }

    /// Creates a toggle row, appends its hosted view to `quickSettingsHostedViews`,
    /// and inserts the menu item at `cursor`. Returns the next cursor position.
    @discardableResult
    private func appendToggle(
        into menu: NSMenu,
        at cursor: Int,
        width: CGFloat,
        icon: String,
        label: String,
        isOn: Bool,
        onToggle: @escaping () -> Void) -> Int
    {
        let hosted = ClickableMenuItemHostView(
            rootView: AnyView(QuickSettingsRow(icon: icon, label: label, isOn: isOn, width: width)),
            width: width)
        hosted.showsHighlight = false
        self.quickSettingsHostedViews.append(hosted)
        hosted.onClick = { [weak self] in
            onToggle()
            self?.refreshQuickSettingsVisuals()
        }
        let item = NSMenuItem()
        item.tag = self.quickSettingsTag
        item.isEnabled = true
        item.view = hosted
        menu.insertItem(item, at: cursor)
        return cursor + 1
    }

    /// Updates existing hosted views in place so SwiftUI can diff and animate
    /// the CapsuleToggle transitions smoothly.
    private func refreshQuickSettingsVisuals() {
        let w = self.currentWidth
        let state = AppStateStore.shared
        let configs: [(String, String, Bool)] = [
            ("waveform.path.ecg", "Send Heartbeats", state.heartbeatsEnabled),
            ("globe", "Browser Control", self.quickSettingsBrowserControlEnabled),
            ("camera", "Allow Camera", UserDefaults.standard.bool(forKey: cameraEnabledKey)),
            ("rectangle.and.pencil.and.ellipsis", "Allow Canvas", state.canvasEnabled),
            ("mic.fill", "Voice Wake", self.voiceWakePendingIsOn ?? state.swabbleEnabled),
        ]
        for (index, (icon, label, isOn)) in configs.enumerated() {
            guard index < self.quickSettingsHostedViews.count else { break }
            self.quickSettingsHostedViews[index].update(
                rootView: AnyView(QuickSettingsRow(icon: icon, label: label, isOn: isOn, width: w)),
                width: w)
        }
        if let execHosted = self.execApprovalsHostedView {
            execHosted.update(
                rootView: AnyView(MenuSubMenuRow(
                    icon: "terminal",
                    label: "Exec Approvals",
                    currentValue: state.execApprovalMode.title,
                    width: w)),
                width: w)
        }
    }

    private func buildExecApprovalsSubmenu(state: AppState, width: CGFloat) -> NSMenu {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for mode in ExecApprovalQuickMode.allCases {
            let isSelected = state.execApprovalMode == mode
            let hosted = HighlightedMenuItemHostView(
                rootView: AnyView(MenuPickerRow(label: mode.title, isSelected: isSelected, width: width)),
                width: width)
            let item = NSMenuItem()
            item.target = self
            item.action = #selector(self.selectExecApprovalMode(_:))
            item.representedObject = mode.rawValue
            item.view = hosted
            submenu.addItem(item)
        }
        return submenu
    }

    @objc
    private func selectExecApprovalMode(_ sender: NSMenuItem) {
        guard let rawValue = sender.representedObject as? String,
              let mode = ExecApprovalQuickMode(rawValue: rawValue) else { return }
        let state = AppStateStore.shared
        state.execApprovalMode = mode
        self.refreshQuickSettingsVisuals()
    }

    /// Injects the "Actions" section label just before the "Open Dashboard" button.
    private func injectActionsLabel(into menu: NSMenu) {
        for item in menu.items where item.tag == self.actionsTag {
            menu.removeItem(item)
        }
        guard let dashIdx = menu.items.firstIndex(where: { $0.title == "Open Dashboard" }) else { return }
        let width = self.initialWidth(for: menu)
        let label = NSMenuItem()
        label.tag = self.actionsTag
        label.isEnabled = false
        label.view = self.makeHostedView(
            rootView: AnyView(MenuSectionLabelView(title: "Actions", width: width)),
            width: width,
            highlighted: false)
        menu.insertItem(label, at: dashIdx)
    }

    /// Injects the "App" section label just before the "Settings…" button.
    private func injectAppLabel(into menu: NSMenu) {
        for item in menu.items where item.tag == self.appLabelTag {
            menu.removeItem(item)
        }
        guard let settingsIdx = menu.items.firstIndex(where: { $0.title == "Settings…" }) else { return }
        let width = self.initialWidth(for: menu)
        let label = NSMenuItem()
        label.tag = self.appLabelTag
        label.isEnabled = false
        label.view = self.makeHostedView(
            rootView: AnyView(MenuSectionLabelView(title: "App", width: width)),
            width: width,
            highlighted: false)
        menu.insertItem(label, at: settingsIdx)
    }

    /// Wraps native SwiftUI menu items in the Actions and App sections with custom host views
    /// so they receive the same grey-hover treatment as all other custom rows.
    /// Items with a submenu get `HighlightedMenuItemHostView`; plain buttons get
    /// `ClickableMenuItemHostView` (grey hover + click re-fires via NSApp.sendAction).
    /// Already-wrapped items (tag == nativeItemsTag) are updated in place.
    private func injectNativeItemViews(into menu: NSMenu) {
        guard let actionsStart = menu.items.firstIndex(where: { $0.tag == self.actionsTag }) else { return }
        let width = self.initialWidth(for: menu)
        let items = menu.items
        for i in (actionsStart + 1)..<items.count {
            let item = items[i]
            guard !item.isSeparatorItem else { continue }
            let isAlreadyWrapped = item.tag == self.nativeItemsTag
            let isNative = item.tag == 0 && item.view == nil
            guard isAlreadyWrapped || isNative else { continue }
            guard let image = item.image else { continue }
            let title = item.title
            guard !title.isEmpty else { continue }

            let hasSubmenu = item.submenu != nil
            let rowView = AnyView(MenuNativeItemRow(
                image: image,
                label: title,
                hasSubmenu: hasSubmenu,
                width: width))

            if isAlreadyWrapped {
                if let hosted = item.view as? HighlightedMenuItemHostView {
                    hosted.update(rootView: rowView, width: width)
                }
            } else if hasSubmenu {
                item.view = HighlightedMenuItemHostView(rootView: rowView, width: width)
                item.tag = self.nativeItemsTag
            } else {
                let hosted = ClickableMenuItemHostView(rootView: rowView, width: width)
                let target = item.target
                let action = item.action
                if let action {
                    hosted.onClick = { [weak item] in
                        guard let item else { return }
                        NSApp.sendAction(action, to: target, from: item)
                    }
                }
                item.view = hosted
                item.tag = self.nativeItemsTag
            }
        }
    }

    private func refreshQuickSettingsBrowserControl() async {
        let root = await ConfigStore.load()
        let browser = root["browser"] as? [String: Any]
        self.quickSettingsBrowserControlEnabled = browser?["enabled"] as? Bool ?? true
    }

    private func makeGatewayItem(entry: NodeInfo, width: CGFloat) -> NSMenuItem {
        let item = NSMenuItem()
        item.tag = self.nodesTag
        item.target = self
        item.action = #selector(self.copyNodeSummary(_:))
        item.representedObject = NodeMenuEntryFormatter.summaryText(entry)
        item.view = HighlightedMenuItemHostView(
            rootView: AnyView(GatewayMenuRowView(entry: entry, width: width)),
            width: width)
        item.submenu = self.buildNodeSubmenu(entry: entry, width: width)
        return item
    }

    private func buildDevicesSubmenu(entries: [NodeInfo], width: CGFloat) -> NSMenu {
        let submenu = NSMenu()

        if case .connecting = ControlChannel.shared.state {
            let msg = self.makeMessageItem(text: "Connecting…", symbolName: "circle.dashed", width: width)
            msg.tag = 0
            submenu.addItem(msg)
            return submenu
        }

        guard self.isControlChannelConnected else {
            let msg = self.makeMessageItem(text: "Gateway not connected", symbolName: "bolt.slash", width: width)
            msg.tag = 0
            submenu.addItem(msg)
            return submenu
        }

        if let error = self.nodesStore.lastError?.nonEmpty {
            let msg = self.makeMessageItem(
                text: "Error: \(error)",
                symbolName: "exclamationmark.triangle",
                width: width)
            msg.tag = 0
            submenu.addItem(msg)
        } else if let status = self.nodesStore.statusMessage?.nonEmpty {
            let msg = self.makeMessageItem(text: status, symbolName: "info.circle", width: width)
            msg.tag = 0
            submenu.addItem(msg)
        }

        if entries.isEmpty {
            let title = self.nodesStore.isLoading ? "Loading devices…" : "No devices yet"
            let msg = self.makeMessageItem(text: title, symbolName: "circle.dashed", width: width)
            msg.tag = 0
            submenu.addItem(msg)
        } else {
            for entry in entries {
                let item = self.makeNodeItem(entry: entry, width: width)
                item.tag = 0
                submenu.addItem(item)
            }
        }

        return submenu
    }

    private func insertUsageSection(into menu: NSMenu, at cursor: Int, width: CGFloat) -> Int {
        let rows = self.usageRows
        if rows.isEmpty {
            return cursor
        }

        var cursor = cursor

        let headerItem = NSMenuItem()
        headerItem.tag = self.tag
        headerItem.isEnabled = false
        headerItem.view = self.makeHostedView(
            rootView: AnyView(MenuUsageHeaderView(
                count: rows.count)),
            width: width,
            highlighted: true)
        menu.insertItem(headerItem, at: cursor)
        cursor += 1

        if let selectedProvider = self.selectedUsageProviderId,
           let primary = rows.first(where: { $0.providerId.lowercased() == selectedProvider }),
           rows.count > 1
        {
            let others = rows.filter { $0.providerId.lowercased() != selectedProvider }

            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = true
            if !others.isEmpty {
                item.submenu = self.buildUsageOverflowMenu(rows: others, width: width)
            }
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: primary, width: width, showsChevron: !others.isEmpty)),
                width: width,
                highlighted: true)
            menu.insertItem(item, at: cursor)
            cursor += 1

            return self.insertUsageCostRowIfAvailable(into: menu, at: cursor)
        }

        for row in rows {
            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = false
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: row, width: width)),
                width: width,
                highlighted: false)
            menu.insertItem(item, at: cursor)
            cursor += 1
        }

        return self.insertUsageCostRowIfAvailable(into: menu, at: cursor)
    }

    private func insertUsageCostRowIfAvailable(into menu: NSMenu, at cursor: Int) -> Int {
        guard self.isControlChannelConnected else { return cursor }
        guard let submenu = self.buildCostUsageSubmenu(width: self.submenuWidth()) else { return cursor }
        var cursor = cursor

        let width = self.currentWidth
        let view = AnyView(MenuSubMenuRow(
            icon: "chart.bar.xaxis",
            label: "Usage cost (30 days)",
            currentValue: "",
            width: width))
        let hosted = HighlightedMenuItemHostView(rootView: view, width: width)
        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = true
        item.view = hosted
        item.submenu = submenu
        menu.insertItem(item, at: cursor)
        cursor += 1
        return cursor
    }

    private var selectedUsageProviderId: String? {
        guard let model = self.cachedSnapshot?.defaults.model.nonEmpty else { return nil }
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = trimmed.firstIndex(of: "/") else { return nil }
        let provider = trimmed[..<slash].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return provider.nonEmpty
    }

    private var usageRows: [UsageRow] {
        guard let summary = self.cachedUsageSummary else { return [] }
        return summary.primaryRows()
    }

    private func buildUsageOverflowMenu(rows: [UsageRow], width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        for row in rows {
            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = false
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: row, width: width)),
                width: width,
                highlighted: false)
            menu.addItem(item)
        }
        return menu
    }

    private var isControlChannelConnected: Bool {
        #if DEBUG
        if let override = self.testControlChannelConnected { return override }
        #endif
        if case .connected = ControlChannel.shared.state { return true }
        return false
    }

    private func controlChannelStatusText(for state: ControlChannel.ConnectionState) -> String {
        switch state {
        case .connected:
            "Loading sessions…"
        case .connecting:
            "Connecting…"
        case let .degraded(message):
            message.nonEmpty ?? "Gateway disconnected"
        case .disconnected:
            "Gateway disconnected"
        }
    }

    private func buildCostUsageSubmenu(width: CGFloat) -> NSMenu? {
        if let error = self.cachedCostErrorText, !error.isEmpty, self.cachedCostSummary == nil {
            let menu = NSMenu()
            let item = NSMenuItem(title: error, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
            return menu
        }

        guard let summary = self.cachedCostSummary else { return nil }
        guard !summary.daily.isEmpty else { return nil }

        let menu = NSMenu()

        let chartView = CostUsageHistoryMenuView(summary: summary, width: width)
        let hosting = NSHostingView(rootView: AnyView(chartView))
        hosting.frame.size.width = max(1, width)
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: max(1, width), height: size.height))

        let chartItem = NSMenuItem()
        chartItem.view = hosting
        chartItem.isEnabled = false
        menu.addItem(chartItem)

        return menu
    }

    private func gatewayEntry() -> NodeInfo? {
        let mode = AppStateStore.shared.connectionMode
        let isConnected = self.isControlChannelConnected
        let port = GatewayEnvironment.gatewayPort()
        var host: String?
        var platform: String?

        switch mode {
        case .remote:
            platform = "remote"
            if AppStateStore.shared.remoteTransport == .direct {
                let trimmedUrl = AppStateStore.shared.remoteUrl
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let url = URL(string: trimmedUrl), let urlHost = url.host, !urlHost.isEmpty {
                    if let port = url.port {
                        host = "\(urlHost):\(port)"
                    } else {
                        host = urlHost
                    }
                } else {
                    host = trimmedUrl.nonEmpty
                }
            } else {
                let target = AppStateStore.shared.remoteTarget
                if let parsed = CommandResolver.parseSSHTarget(target) {
                    host = parsed.port == 22 ? parsed.host : "\(parsed.host):\(parsed.port)"
                } else {
                    host = target.nonEmpty
                }
            }
        case .local:
            platform = "local"
            host = GatewayConnectivityCoordinator.shared.localEndpointHostLabel ?? "127.0.0.1:\(port)"
        case .unconfigured:
            platform = nil
            host = nil
        }

        return NodeInfo(
            nodeId: "gateway",
            displayName: "Gateway",
            platform: platform,
            version: nil,
            coreVersion: nil,
            uiVersion: nil,
            deviceFamily: nil,
            modelIdentifier: nil,
            remoteIp: host,
            caps: nil,
            commands: nil,
            permissions: nil,
            paired: nil,
            connected: isConnected)
    }

    private func makeNodeItem(entry: NodeInfo, width: CGFloat) -> NSMenuItem {
        let item = NSMenuItem()
        item.tag = self.nodesTag
        item.target = self
        item.action = #selector(self.copyNodeSummary(_:))
        item.representedObject = NodeMenuEntryFormatter.summaryText(entry)
        item.view = HighlightedMenuItemHostView(
            rootView: AnyView(NodeMenuRowView(entry: entry, width: width)),
            width: width)
        item.submenu = self.buildNodeSubmenu(entry: entry, width: width)
        return item
    }

    private func makeSessionPreviewItem(
        sessionKey: String,
        title: String,
        width: CGFloat,
        maxLines: Int) -> NSMenuItem
    {
        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = false
        let view = AnyView(
            SessionMenuPreviewView(
                width: width,
                maxLines: maxLines,
                title: title,
                items: [],
                status: .loading)
                .environment(\.isEnabled, true))
        let hosted = HighlightedMenuItemHostView(rootView: view, width: width)
        item.view = hosted

        let task = Task { [weak hosted, weak item] in
            let snapshot = await SessionMenuPreviewLoader.load(sessionKey: sessionKey, maxItems: 10)
            guard !Task.isCancelled else { return }

            await MainActor.run {
                let nextView = AnyView(
                    SessionMenuPreviewView(
                        width: width,
                        maxLines: maxLines,
                        title: title,
                        items: snapshot.items,
                        status: snapshot.status)
                        .environment(\.isEnabled, true))

                if let item {
                    item.view = HighlightedMenuItemHostView(rootView: nextView, width: width)
                    return
                }

                guard let hosted else { return }
                hosted.update(rootView: nextView, width: width)
            }
        }
        self.previewTasks.append(task)
        return item
    }

    private func cancelPreviewTasks() {
        for task in self.previewTasks {
            task.cancel()
        }
        self.previewTasks.removeAll()
    }

    private func makeMessageItem(text: String, symbolName: String, width: CGFloat, maxLines: Int? = 2) -> NSMenuItem {
        let view = AnyView(
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbolName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 14, alignment: .leading)
                    .padding(.top, 1)

                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(maxLines)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .padding(.leading, 18)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .frame(width: max(1, width), alignment: .leading))

        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = false
        item.view = self.makeHostedView(rootView: view, width: width, highlighted: false)
        return item
    }
}

extension MenuSessionsInjector {
    // MARK: - Cache

    private func refreshCache(force: Bool) async {
        if !force, let updated = self.cacheUpdatedAt, Date().timeIntervalSince(updated) < self.refreshIntervalSeconds {
            return
        }

        guard self.isControlChannelConnected else {
            if self.cachedSnapshot != nil {
                self.cachedErrorText = "Gateway disconnected (showing cached)"
            } else {
                self.cachedErrorText = nil
            }
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

    private func refreshUsageCache(force: Bool) async {
        if !force,
           let updated = self.usageCacheUpdatedAt,
           Date().timeIntervalSince(updated) < self.usageRefreshIntervalSeconds
        {
            return
        }

        guard self.isControlChannelConnected else {
            self.usageCacheUpdatedAt = Date()
            return
        }

        do {
            self.cachedUsageSummary = try await UsageLoader.loadSummary()
        } catch {
            self.cachedUsageSummary = nil
            self.cachedUsageErrorText = nil
        }
        self.usageCacheUpdatedAt = Date()
    }

    private func refreshCostUsageCache(force: Bool) async {
        if !force,
           let updated = self.costCacheUpdatedAt,
           Date().timeIntervalSince(updated) < self.costRefreshIntervalSeconds
        {
            return
        }

        guard self.isControlChannelConnected else {
            self.costCacheUpdatedAt = Date()
            return
        }

        do {
            self.cachedCostSummary = try await CostUsageLoader.loadSummary()
            self.cachedCostErrorText = nil
        } catch {
            self.cachedCostSummary = nil
            self.cachedCostErrorText = self.compactUsageError(error)
        }
        self.costCacheUpdatedAt = Date()
    }

    private func compactUsageError(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty { return "Usage unavailable" }
        if message.count > 90 { return "\(message.prefix(87))…" }
        return message
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
}

extension MenuSessionsInjector {
    // MARK: - Submenus

    private func buildSubmenu(for row: SessionRow, storePath: String) -> NSMenu {
        let menu = NSMenu()
        let width = self.submenuWidth()

        menu.addItem(self.makeSessionPreviewItem(
            sessionKey: row.key,
            title: "Recent messages (last 10)",
            width: width,
            maxLines: 3))

        let morePreview = NSMenuItem(title: "More preview…", action: nil, keyEquivalent: "")
        morePreview.submenu = self.buildPreviewSubmenu(sessionKey: row.key, width: width)
        menu.addItem(morePreview)

        menu.addItem(NSMenuItem.separator())

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
            let openLog = NSMenuItem(
                title: "Open Session Log",
                action: #selector(self.openSessionLog(_:)),
                keyEquivalent: "")
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

        let compact = NSMenuItem(
            title: "Compact Session Log",
            action: #selector(self.compactSession(_:)),
            keyEquivalent: "")
        compact.target = self
        compact.representedObject = row.key
        menu.addItem(compact)

        if row.key != self.mainSessionKey, row.key != "global" {
            let del = NSMenuItem(title: "Delete Session", action: #selector(self.deleteSession(_:)), keyEquivalent: "")
            del.target = self
            del.representedObject = row.key
            del.isAlternate = false
            del.keyEquivalentModifierMask = []
            menu.addItem(del)
        }

        return menu
    }

    private func buildThinkingMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.showsStateColumn = true
        let levels: [String] = ["off", "minimal", "low", "medium", "high"]
        let current = levels.contains(row.thinkingLevel ?? "") ? row.thinkingLevel ?? "off" : "off"
        for level in levels {
            let title = level.capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchThinking(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (current == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildVerboseMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.showsStateColumn = true
        let levels: [String] = ["on", "off"]
        let current = levels.contains(row.verboseLevel ?? "") ? row.verboseLevel ?? "off" : "off"
        for level in levels {
            let title = level.capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchVerbose(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (current == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildPreviewSubmenu(sessionKey: String, width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(self.makeSessionPreviewItem(
            sessionKey: sessionKey,
            title: "Recent messages (expanded)",
            width: width,
            maxLines: 8))
        return menu
    }

    private func buildNodesOverflowMenu(entries: [NodeInfo], width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        for entry in entries {
            let item = NSMenuItem()
            item.target = self
            item.action = #selector(self.copyNodeSummary(_:))
            item.representedObject = NodeMenuEntryFormatter.summaryText(entry)
            item.view = HighlightedMenuItemHostView(
                rootView: AnyView(NodeMenuRowView(entry: entry, width: width)),
                width: width)
            item.submenu = self.buildNodeSubmenu(entry: entry, width: width)
            menu.addItem(item)
        }
        return menu
    }

    private func buildNodeSubmenu(entry: NodeInfo, width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        menu.addItem(self.makeNodeCopyItem(label: "Node ID", value: entry.nodeId))

        if let name = entry.displayName?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "Name", value: name))
        }

        if let ip = entry.remoteIp?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "IP", value: ip))
        }

        menu.addItem(self.makeNodeCopyItem(label: "Status", value: NodeMenuEntryFormatter.roleText(entry)))

        if let platform = NodeMenuEntryFormatter.platformText(entry) {
            menu.addItem(self.makeNodeCopyItem(label: "Platform", value: platform))
        }

        if let version = NodeMenuEntryFormatter.detailRightVersion(entry)?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "Version", value: version))
        }

        menu.addItem(self.makeNodeDetailItem(label: "Connected", value: entry.isConnected ? "Yes" : "No"))
        menu.addItem(self.makeNodeDetailItem(label: "Paired", value: entry.isPaired ? "Yes" : "No"))

        if let caps = entry.caps?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !caps.isEmpty
        {
            menu.addItem(self.makeNodeCopyItem(label: "Caps", value: caps.joined(separator: ", ")))
        }

        if let commands = entry.commands?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !commands.isEmpty
        {
            menu.addItem(self.makeNodeMultilineItem(
                label: "Commands",
                value: commands.joined(separator: ", "),
                width: width))
        }

        return menu
    }

    private func makeNodeDetailItem(label: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: "\(label): \(value)", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func makeNodeCopyItem(label: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: "\(label): \(value)", action: #selector(self.copyNodeValue(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = value
        return item
    }

    private func makeNodeMultilineItem(label: String, value: String, width: CGFloat) -> NSMenuItem {
        let item = NSMenuItem()
        item.target = self
        item.action = #selector(self.copyNodeValue(_:))
        item.representedObject = value
        item.view = HighlightedMenuItemHostView(
            rootView: AnyView(NodeMenuMultilineView(label: label, value: value, width: width)),
            width: width)
        return item
    }

    private func formatVersionLabel(_ version: String) -> String {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return version }
        if trimmed.hasPrefix("v") { return trimmed }
        if let first = trimmed.unicodeScalars.first, CharacterSet.decimalDigits.contains(first) {
            return "v\(trimmed)"
        }
        return trimmed
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

    @objc
    private func copyNodeSummary(_ sender: NSMenuItem) {
        guard let summary = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(summary, forType: .string)
    }

    @objc
    private func copyNodeValue(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

extension MenuSessionsInjector {
    // MARK: - Width + placement

    private func findInsertIndex(in menu: NSMenu) -> Int? {
        // Insert right after the Status section (nodesTag items).
        if let last = menu.items.lastIndex(where: { $0.tag == self.nodesTag }) {
            return last + 1
        }
        // Fallback: after active header section.
        if let last = menu.items.lastIndex(where: { $0.tag == self.activeHeaderTag }) {
            return last + 1
        }
        if let sepIdx = menu.items.firstIndex(where: { $0.isSeparatorItem }) {
            return sepIdx
        }
        if menu.items.count >= 1 { return 1 }
        return menu.items.count
    }

    /// Insertion point for the Status section: right after the active header items.
    private func statusInsertIndex(in menu: NSMenu) -> Int {
        if let last = menu.items.lastIndex(where: { $0.tag == self.activeHeaderTag }) {
            return last + 1
        }
        return 2
    }

    /// Insertion point for Quick Settings: right after the last Activity/sessions item.
    private func findQuickSettingsInsertIndex(in menu: NSMenu) -> Int? {
        if let last = menu.items.lastIndex(where: { $0.tag == self.tag }) {
            return last + 1
        }
        // Fallback: after the Status section.
        if let last = menu.items.lastIndex(where: { $0.tag == self.nodesTag }) {
            return last + 1
        }
        return nil
    }

    private var currentWidth: CGFloat {
        if let w = self.menuOpenWidth { return max(self.fallbackWidth, w) }
        return max(self.fallbackWidth, self.lastKnownMenuWidth ?? 0)
    }

    private func initialWidth(for menu: NSMenu) -> CGFloat {
        // Prefer the width captured at menu open; update it if the live window
        // is wider (items may have been injected since open).
        let live = self.currentMenuWidth(for: menu)
        if let openWidth = self.menuOpenWidth {
            let best = max(openWidth, live)
            self.menuOpenWidth = best
            return max(self.fallbackWidth, best)
        }
        return max(self.fallbackWidth, live)
    }

    private func submenuWidth() -> CGFloat {
        if let openWidth = self.menuOpenWidth {
            return max(300, openWidth)
        }
        if let cached = self.lastKnownMenuWidth {
            return max(300, cached)
        }
        return self.fallbackWidth
    }

    private func menuWindowWidth(for menu: NSMenu) -> CGFloat? {
        var menuWindow: NSWindow?
        for item in menu.items {
            if let window = item.view?.window {
                menuWindow = window
                break
            }
        }
        guard let width = menuWindow?.contentView?.bounds.width, width > 0 else { return nil }
        return width
    }

    private func sortedNodeEntries() -> [NodeInfo] {
        let entries = self.nodesStore.nodes.filter(\.isConnected)
        return entries.sorted { lhs, rhs in
            if lhs.isConnected != rhs.isConnected { return lhs.isConnected }
            if lhs.isPaired != rhs.isPaired { return lhs.isPaired }
            let lhsName = NodeMenuEntryFormatter.primaryName(lhs).lowercased()
            let rhsName = NodeMenuEntryFormatter.primaryName(rhs).lowercased()
            if lhsName == rhsName { return lhs.nodeId < rhs.nodeId }
            return lhsName < rhsName
        }
    }
}

extension MenuSessionsInjector {
    // MARK: - Views

    private func makeHostedView(rootView: AnyView, width: CGFloat, highlighted: Bool) -> NSView {
        if highlighted {
            return HighlightedMenuItemHostView(rootView: rootView, width: width)
        }

        let hosting = NSHostingView(rootView: rootView)
        hosting.frame.size.width = max(1, width)
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
        return hosting
    }

    private func captureMenuWidthIfAvailable(from view: NSView) {
        guard !self.isMenuOpen else { return }
        guard let width = view.window?.contentView?.bounds.width, width > 0 else { return }
        self.lastKnownMenuWidth = max(300, width)
    }

    private func currentMenuWidth(for menu: NSMenu) -> CGFloat {
        if let width = self.menuWindowWidth(for: menu) {
            return max(300, width)
        }
        let candidates: [CGFloat] = [
            menu.size.width,
            menu.minimumWidth,
            self.lastKnownMenuWidth ?? 0,
            self.fallbackWidth,
        ]
        let resolved = candidates.max() ?? self.fallbackWidth
        return max(300, resolved)
    }
}

#if DEBUG
extension MenuSessionsInjector {
    func setTestingControlChannelConnected(_ connected: Bool?) {
        self.testControlChannelConnected = connected
    }

    func setTestingSnapshot(_ snapshot: SessionStoreSnapshot?, errorText: String? = nil) {
        self.cachedSnapshot = snapshot
        self.cachedErrorText = errorText
        self.cacheUpdatedAt = Date()
    }

    func setTestingUsageSummary(_ summary: GatewayUsageSummary?, errorText: String? = nil) {
        self.cachedUsageSummary = summary
        self.cachedUsageErrorText = errorText
        self.usageCacheUpdatedAt = Date()
    }

    func injectForTesting(into menu: NSMenu) {
        self.inject(into: menu)
    }
}
#endif
