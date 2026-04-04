import AppKit
import Observation
import OpenClawKit
import QuartzCore
import SwiftUI

/// Hover-only HUD anchored to the menu bar item. Click expands into full Web Chat.
@MainActor
@Observable
final class HoverHUDController {
    static let shared = HoverHUDController()
    private static let pinnedDefaultsKey = "openclaw.hoverWidgetPinned"
    private static let compactDefaultsKey = "openclaw.hoverWidgetCompact"

    struct Model {
        var isVisible: Bool = false
        var isSuppressed: Bool = false
        var hoveringStatusItem: Bool = false
        var hoveringPanel: Bool = false
        var isPinned: Bool = false
        var isCompact: Bool = false
        var isCharm: Bool = false
    }

    private(set) var model: Model

    private var window: NSPanel?
    private var hostingView: NSHostingView<HoverHUDView>?
    private var dismissMonitor: Any?
    private var dismissTask: Task<Void, Never>?
    private var showTask: Task<Void, Never>?
    private var anchorProvider: (() -> NSRect?)?
    private var visibilityTransitionID: UInt = 0

    private let idealSize = NSSize(width: 458, height: 316)
    private let minimumSize = NSSize(width: 386, height: 272)
    private let compactIdealSize = NSSize(width: 376, height: 96)
    private let compactMinimumSize = NSSize(width: 320, height: 82)
    private let charmIdealSize = NSSize(width: 64, height: 64)
    private let charmMinimumSize = NSSize(width: 54, height: 54)
    private let statusItemDockSize = NSSize(width: 32, height: 24)
    private let anchoredPadding: CGFloat = 8
    private let charmPadding: CGFloat = 4
    private let pinnedPadding: CGFloat = 16
    private let hoverShowDelay: TimeInterval = 0.18

    private var keepsWindowVisible: Bool {
        self.model.isPinned || self.model.isCompact
    }

    private var hasVisiblePrimaryAppWindow: Bool {
        (NSApp?.windows ?? []).contains(where: DockIconManager.countsAsPrimaryAppWindow)
    }

    private init() {
        self.model = Model(
            isPinned: compatibleDefaultsBool(forKey: Self.pinnedDefaultsKey),
            isCompact: compatibleDefaultsBool(forKey: Self.compactDefaultsKey))
    }

    func setSuppressed(_ suppressed: Bool) {
        self.model.isSuppressed = suppressed
        if suppressed {
            self.showTask?.cancel()
            self.showTask = nil
            if !self.keepsWindowVisible {
                self.dismiss(reason: "suppressed")
            }
        }
    }

    func statusItemHoverChanged(inside: Bool, anchorProvider: @escaping () -> NSRect?) {
        self.model.hoveringStatusItem = inside
        self.anchorProvider = anchorProvider

        if self.model.isCharm {
            self.showTask?.cancel()
            self.showTask = nil
            if !inside {
                self.dismissTask?.cancel()
                self.dismissTask = nil
            }
            return
        }

        guard !self.model.isSuppressed else { return }

        if inside {
            self.dismissTask?.cancel()
            self.dismissTask = nil
            self.showTask?.cancel()
            self.showTask = Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(self.hoverShowDelay * 1_000_000_000))
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    guard !Task.isCancelled else { return }
                    guard self.model.hoveringStatusItem || self.keepsWindowVisible else { return }
                    guard !self.model.isSuppressed else { return }
                    self.present()
                }
            }
        } else {
            self.showTask?.cancel()
            self.showTask = nil
            if !self.keepsWindowVisible {
                self.scheduleDismiss()
            }
        }
    }

    func panelHoverChanged(inside: Bool) {
        self.model.hoveringPanel = inside
        if inside {
            self.dismissTask?.cancel()
            self.dismissTask = nil
        } else if !self.model.hoveringStatusItem, !self.keepsWindowVisible {
            self.scheduleDismiss()
        }
    }

    func openChat() {
        guard let anchorProvider = self.anchorProvider else { return }
        if !self.keepsWindowVisible {
            self.dismiss(reason: "openChat")
        }
        Task { @MainActor in
            let sessionKey = await WebChatManager.shared.preferredSessionKey()
            WebChatManager.shared.togglePanel(sessionKey: sessionKey, anchorProvider: anchorProvider)
        }
    }

    func openCorrectionWorkspace() {
        if !self.keepsWindowVisible {
            self.dismiss(reason: "openCorrectionWorkspace")
        }
        CorrectionWorkspaceWindowOpener.shared.open()
    }

    func openSettings(tab: SettingsTab = .general) {
        if !self.keepsWindowVisible {
            self.dismiss(reason: "openSettings")
        }
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    func refreshHealth() {
        Task { await HealthStore.shared.refresh(onDemand: true) }
    }

    func togglePinned() {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.model.isPinned.toggle()
        self.persistPinnedState()

        if self.model.isVisible {
            self.updateWindowFrame(animate: true)
        }

        if !self.keepsWindowVisible, !self.model.hoveringStatusItem, !self.model.hoveringPanel {
            self.scheduleDismiss()
        }
    }

    func toggleCompact() {
        if self.model.isCharm {
            self.model.isCharm = false
        }
        self.model.isCompact.toggle()
        self.persistCompactState()
        if self.model.isVisible {
            self.updateWindowFrame(animate: true)
        }
    }

    func toggleCharm() {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.showTask?.cancel()
        self.showTask = nil

        if self.model.isCharm {
            self.expandFromCharm()
            return
        }

        if self.model.isPinned {
            self.model.isPinned = false
            self.persistPinnedState()
        }

        self.model.isCompact = false
        self.collapseIntoStatusItem()
    }

    func expandFromCharm() {
        guard self.model.isCharm else { return }
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.model.isCharm = false
        self.model.isCompact = false
        self.model.isSuppressed = false
        if self.model.isVisible {
            self.updateWindowFrame(animate: true)
        } else {
            self.present(expandingFromStatusItem: true)
        }
    }

    func openExpandedFromStatusItem(anchorProvider: @escaping () -> NSRect?) {
        self.anchorProvider = anchorProvider
        self.model.isSuppressed = false
        self.dismissTask?.cancel()
        self.showTask?.cancel()
        self.model.isCharm = false
        self.model.isCompact = false
        self.present(expandingFromStatusItem: true)
    }

    func closeWidget() {
        self.showTask?.cancel()
        self.showTask = nil
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.model.isPinned = false
        self.model.isCompact = false
        self.model.isCharm = false
        self.persistPinnedState()
        self.persistCompactState()
        self.dismiss(reason: "closeWidget")
    }

    func resetForTests() {
        guard ProcessInfo.processInfo.isRunningTests else { return }

        self.showTask?.cancel()
        self.showTask = nil
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.removeDismissMonitor()
        self.anchorProvider = nil
        self.visibilityTransitionID = 0
        self.model = Model()
        self.persistPinnedState()
        self.persistCompactState()
        self.window?.orderOut(nil)
    }

    func openWidgetFromMenu(compact: Bool? = nil) {
        if let compact, self.model.isCompact != compact {
            self.model.isCompact = compact
            self.persistCompactState()
        }

        // Menu actions should open the floating desktop companion, not reuse
        // the transient status-item anchor from a previous hover/click.
        self.anchorProvider = nil
        self.showTask?.cancel()
        self.dismissTask?.cancel()
        self.showTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 160_000_000)
            await MainActor.run { [weak self] in
                guard let self else { return }
                guard !Task.isCancelled else { return }
                self.model.isSuppressed = false
                self.model.isCharm = false
                self.present(expandingFromStatusItem: true)
            }
        }
    }

    func restorePinnedWidgetIfNeeded() {
        guard self.keepsWindowVisible else { return }
        guard !self.model.isVisible else { return }
        guard !self.model.isSuppressed else { return }
        guard !self.hasVisiblePrimaryAppWindow else { return }
        self.present()
    }

    func schedulePinnedWidgetRecovery() {
        guard self.keepsWindowVisible else { return }

        for delay in [0.4, 1.2, 2.4] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self else { return }
                guard self.keepsWindowVisible else { return }
                guard !self.model.isSuppressed else { return }
                guard !self.hasVisiblePrimaryAppWindow else { return }
                if !self.model.isVisible {
                    self.present()
                } else {
                    self.updateWindowFrame(animate: true)
                }
            }
        }
    }

    func dismiss(reason: String = "explicit") {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.removeDismissMonitor()
        let transitionID = self.beginVisibilityTransition()
        let wasVisible = self.model.isVisible
        self.model.isVisible = false
        guard let window else {
            return
        }

        if !wasVisible {
            window.orderOut(nil)
            return
        }

        OverlayPanelFactory.animateDismiss(window: window, offsetX: 0, offsetY: 6, duration: 0.14) { [weak self, weak window] in
            guard let self, let window else { return }
            guard transitionID == self.visibilityTransitionID else { return }
            window.orderOut(nil)
        }
    }

    // MARK: - Private

    private func scheduleDismiss() {
        self.dismissTask?.cancel()
        self.dismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            await MainActor.run {
                guard let self else { return }
                if self.keepsWindowVisible { return }
                if self.model.hoveringStatusItem || self.model.hoveringPanel { return }
                self.dismiss(reason: "hoverExit")
            }
        }
    }

    private func collapseIntoStatusItem() {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.removeDismissMonitor()
        let transitionID = self.beginVisibilityTransition()
        let wasVisible = self.model.isVisible
        self.model.isVisible = false
        self.model.isCharm = true

        guard let window else {
            return
        }

        guard wasVisible else {
            window.orderOut(nil)
            return
        }

        OverlayPanelFactory.animateDismiss(
            window: window,
            to: self.statusItemDockFrame(),
            offsetX: 0,
            offsetY: 0,
            duration: 0.18)
        { [weak self, weak window] in
            guard let self, let window else { return }
            guard transitionID == self.visibilityTransitionID else { return }
            window.orderOut(nil)
        }
    }

    private func present(expandingFromStatusItem: Bool = false) {
        guard !self.model.isSuppressed else { return }
        _ = self.beginVisibilityTransition()
        self.ensureWindow()
        self.hostingView?.rootView = HoverHUDView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        self.installDismissMonitor()

        if !self.model.isVisible {
            self.model.isVisible = true
            let start = expandingFromStatusItem
                ? (self.statusItemDockFrame() ?? target.offsetBy(dx: 0, dy: 8))
                : target.offsetBy(dx: 0, dy: 8)
            OverlayPanelFactory.animatePresent(window: window, from: start, to: target)
        } else {
            window.orderFrontRegardless()
            self.updateWindowFrame(animate: true)
        }
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let bounds = self.resolvedScreenAndBounds().bounds
        let size = self.targetSize(in: bounds)
        let panel = OverlayPanelFactory.makePanel(
            contentRect: NSRect(origin: .zero, size: size),
            level: .statusBar,
            hasShadow: true)

        let host = NSHostingView(rootView: HoverHUDView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        host.frame = NSRect(origin: .zero, size: size)
        panel.contentView = host
        panel.setContentSize(size)
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        let (screen, bounds) = self.resolvedScreenAndBounds()
        let size = self.targetSize(in: bounds)

        if self.model.isPinned {
            return WindowPlacement.topRightFrame(size: size, padding: self.pinnedPadding, in: bounds)
        }

        guard let anchor = self.anchorProvider?() else {
            let padding = self.model.isCharm ? self.charmPadding : self.anchoredPadding
            return WindowPlacement.topRightFrame(size: size, padding: padding, on: screen)
        }

        return WindowPlacement.anchoredBelowFrame(
            size: size,
            anchor: anchor,
            padding: self.model.isCharm ? self.charmPadding : self.anchoredPadding,
            in: bounds)
    }

    private func statusItemDockFrame() -> NSRect? {
        let (screen, bounds) = self.resolvedScreenAndBounds()

        guard let anchor = self.anchorProvider?() else {
            return WindowPlacement.topRightFrame(size: self.statusItemDockSize, padding: self.charmPadding, on: screen)
        }

        let frameBounds = (screen?.frame ?? bounds).insetBy(dx: 2, dy: 2)
        let width = max(self.statusItemDockSize.width, anchor.width + 8)
        let height = max(self.statusItemDockSize.height, anchor.height + 4)
        let desired = NSRect(
            x: round(anchor.midX - width / 2),
            y: round(anchor.midY - height / 2),
            width: width,
            height: height)

        let maxX = frameBounds.maxX - width
        let maxY = frameBounds.maxY - height
        let x = maxX >= frameBounds.minX ? min(max(desired.minX, frameBounds.minX), maxX) : frameBounds.minX
        let y = maxY >= frameBounds.minY ? min(max(desired.minY, frameBounds.minY), maxY) : frameBounds.minY
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func updateWindowFrame(animate: Bool = false) {
        self.syncContentSize()
        OverlayPanelFactory.applyFrame(window: self.window, target: self.targetFrame(), animate: animate)
    }

    private func installDismissMonitor() {
        if ProcessInfo.processInfo.isRunningTests { return }
        guard self.dismissMonitor == nil, let window else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(matching: [
            .leftMouseDown,
            .rightMouseDown,
            .otherMouseDown,
        ]) { [weak self] _ in
            guard let self, self.model.isVisible else { return }
            if self.keepsWindowVisible { return }
            let pt = NSEvent.mouseLocation
            if !window.frame.contains(pt) {
                Task { @MainActor in self.dismiss(reason: "outsideClick") }
            }
        }
    }

    private func removeDismissMonitor() {
        OverlayPanelFactory.clearGlobalEventMonitor(&self.dismissMonitor)
    }

    private func persistPinnedState() {
        persistCompatibleDefaultsBool(self.model.isPinned, forKey: Self.pinnedDefaultsKey)
    }

    private func persistCompactState() {
        persistCompatibleDefaultsBool(self.model.isCompact, forKey: Self.compactDefaultsKey)
    }

    private func resolvedScreenAndBounds() -> (screen: NSScreen?, bounds: NSRect) {
        let anchor = self.anchorProvider?()
        let screen = NSScreen.screens.first { screen in
            guard let anchor else { return false }
            return screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main

        let inset: CGFloat
        if self.model.isPinned {
            inset = self.pinnedPadding
        } else if self.model.isCharm {
            inset = self.charmPadding
        } else {
            inset = self.anchoredPadding
        }
        let bounds = (screen?.visibleFrame ?? .zero).insetBy(dx: inset, dy: inset)
        return (screen, bounds)
    }

    private func targetSize(in bounds: NSRect) -> NSSize {
        let ideal: NSSize
        let minimum: NSSize

        if self.model.isCharm {
            ideal = self.charmIdealSize
            minimum = self.charmMinimumSize
        } else if self.model.isCompact {
            ideal = self.compactIdealSize
            minimum = self.compactMinimumSize
        } else {
            ideal = self.idealSize
            minimum = self.minimumSize
        }

        return AdaptiveWindowSizing.clampedSize(
            ideal: ideal,
            minimum: minimum,
            padding: self.model.isPinned ? self.pinnedPadding : (self.model.isCharm ? self.charmPadding : self.anchoredPadding),
            within: bounds)
    }

    private func syncContentSize() {
        guard let window else { return }
        let size = self.targetSize(in: self.resolvedScreenAndBounds().bounds)
        self.hostingView?.frame = NSRect(origin: .zero, size: size)
        window.setContentSize(size)
    }

    @discardableResult
    private func beginVisibilityTransition() -> UInt {
        self.visibilityTransitionID &+= 1
        return self.visibilityTransitionID
    }
}

fileprivate enum HoverScene: CaseIterable {
    case chat
    case cases
    case refresh
    case settings
}

enum HoverHUDCasesPresentation {
    static func primaryActionTitle(activeCaseCount: Int, pendingTrialCount: Int) -> String {
        if activeCaseCount > 1 {
            return "Review Open Cases"
        }
        if activeCaseCount == 1 {
            return "Review Focus Case"
        }
        if pendingTrialCount > 0 {
            return "Review Trial Queue"
        }
        return "Open Casebook"
    }

    static func tabBadgeText(activeCaseCount: Int, pendingTrialCount: Int) -> String? {
        if activeCaseCount > 1 {
            return "\(activeCaseCount) Open"
        }
        if activeCaseCount == 1 {
            return "Open"
        }
        if pendingTrialCount > 0 {
            return "Queued"
        }
        return nil
    }
}

enum HoverHUDQuickActionKind: Equatable {
    case chat
    case cases
    case refresh
    case settings
}

struct HoverHUDQuickActionPresentation: Equatable {
    let kind: HoverHUDQuickActionKind
    let title: String
    let systemImage: String
    let guidance: String
}

enum HoverHUDCompactPresentation {
    static func primaryAction(
        healthState: HealthState,
        activeCaseCount: Int,
        pendingTrialCount: Int,
        hasLiveActivity: Bool) -> HoverHUDQuickActionPresentation
    {
        switch healthState {
        case .linkingNeeded:
            return HoverHUDQuickActionPresentation(
                kind: .settings,
                title: "Open Settings",
                systemImage: "slider.horizontal.3",
                guidance: "Repair the gateway path first.")
        case .unknown:
            return HoverHUDQuickActionPresentation(
                kind: .refresh,
                title: "Refresh Status",
                systemImage: "arrow.clockwise",
                guidance: "Refresh before choosing a lane.")
        case .degraded:
            if activeCaseCount > 0 || pendingTrialCount > 0 {
                return self.casesAction(
                    activeCaseCount: activeCaseCount,
                    pendingTrialCount: pendingTrialCount)
            }
            return HoverHUDQuickActionPresentation(
                kind: .refresh,
                title: "Refresh Pulse",
                systemImage: "arrow.clockwise",
                guidance: "Confirm the live pulse first.")
        case .ok:
            if activeCaseCount > 0 || pendingTrialCount > 0 {
                return self.casesAction(
                    activeCaseCount: activeCaseCount,
                    pendingTrialCount: pendingTrialCount)
            }
            if hasLiveActivity {
                return HoverHUDQuickActionPresentation(
                    kind: .chat,
                    title: "Continue Chat",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    guidance: "Return to the active thread.")
            }
            return HoverHUDQuickActionPresentation(
                kind: .chat,
                title: "Open Chat",
                systemImage: "bubble.left.and.bubble.right.fill",
                guidance: "Start in chat.")
        }
    }

    private static func casesAction(
        activeCaseCount: Int,
        pendingTrialCount: Int) -> HoverHUDQuickActionPresentation
    {
        if activeCaseCount > 1 {
            return HoverHUDQuickActionPresentation(
                kind: .cases,
                title: "Review Cases",
                systemImage: "cross.case.fill",
                guidance: "Start with the hottest open loop.")
        }
        if activeCaseCount == 1 {
            return HoverHUDQuickActionPresentation(
                kind: .cases,
                title: "Review Case",
                systemImage: "cross.case.fill",
                guidance: "Close the focused open loop.")
        }
        if pendingTrialCount > 0 {
            return HoverHUDQuickActionPresentation(
                kind: .cases,
                title: "Trial Queue",
                systemImage: "cross.case.fill",
                guidance: "Queued validation is ready.")
        }
        return HoverHUDQuickActionPresentation(
            kind: .cases,
            title: "Open Casebook",
            systemImage: "cross.case.fill",
            guidance: "Open the verification workspace.")
    }
}

enum HoverHUDChatPresentation {
    static func headline(hasLiveActivity: Bool, activeCaseCount: Int, pendingTrialCount: Int) -> String {
        if hasLiveActivity {
            return "Conversation stays in reach"
        }
        if activeCaseCount == 0 && pendingTrialCount == 0 {
            return "Start in chat"
        }
        return "Chat can add context"
    }

    static func moodLine(hasLiveActivity: Bool, activeCaseCount: Int, pendingTrialCount: Int) -> String {
        if hasLiveActivity {
            return "Live thread and quick re-entry"
        }
        if activeCaseCount == 0 && pendingTrialCount == 0 {
            return "Start here when the desk is quiet"
        }
        return "Use chat when you need more context"
    }

    static func detail(
        hasLiveActivity: Bool,
        activeCaseCount: Int,
        pendingTrialCount: Int,
        currentLabel: String?) -> String
    {
        if let currentLabel {
            let trimmed = currentLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return trimmed
            }
        }
        if hasLiveActivity {
            return "Return to the live thread."
        }
        if activeCaseCount == 0 && pendingTrialCount == 0 {
            return "Open chat to begin a new supervision pass."
        }
        return "Use chat to gather context after reviewing the open loop."
    }

    static func secondaryAction(
        healthState: HealthState,
        activeCaseCount: Int,
        pendingTrialCount: Int) -> HoverHUDQuickActionPresentation
    {
        switch healthState {
        case .linkingNeeded:
            return HoverHUDQuickActionPresentation(
                kind: .settings,
                title: "Open Settings",
                systemImage: "slider.horizontal.3",
                guidance: "Repair the gateway path first.")
        case .degraded:
            if activeCaseCount > 0 || pendingTrialCount > 0 {
                return self.casesShortcut(activeCaseCount: activeCaseCount, pendingTrialCount: pendingTrialCount)
            }
            return HoverHUDQuickActionPresentation(
                kind: .refresh,
                title: "Refresh Pulse",
                systemImage: "arrow.clockwise",
                guidance: "Confirm the live pulse first.")
        case .unknown:
            return HoverHUDQuickActionPresentation(
                kind: .refresh,
                title: "Refresh Pulse",
                systemImage: "arrow.clockwise",
                guidance: "Refresh before choosing a lane.")
        case .ok:
            if activeCaseCount > 0 || pendingTrialCount > 0 {
                return self.casesShortcut(activeCaseCount: activeCaseCount, pendingTrialCount: pendingTrialCount)
            }
            return HoverHUDQuickActionPresentation(
                kind: .refresh,
                title: "Check Pulse",
                systemImage: "arrow.clockwise",
                guidance: "Confirm the desk is awake.")
        }
    }

    private static func casesShortcut(
        activeCaseCount: Int,
        pendingTrialCount: Int) -> HoverHUDQuickActionPresentation
    {
        if activeCaseCount > 1 {
            return HoverHUDQuickActionPresentation(
                kind: .cases,
                title: "Review Cases",
                systemImage: "cross.case.fill",
                guidance: "Start with the hottest open loop.")
        }
        if activeCaseCount == 1 {
            return HoverHUDQuickActionPresentation(
                kind: .cases,
                title: "Review Case",
                systemImage: "cross.case.fill",
                guidance: "Close the focused open loop.")
        }
        return HoverHUDQuickActionPresentation(
            kind: .cases,
            title: "Trial Queue",
            systemImage: "cross.case.fill",
            guidance: "Queued validation is ready.")
    }
}

private struct HoverHUDView: View {

    var controller: HoverHUDController
    private let activityStore = WorkActivityStore.shared
    private let healthStore = HealthStore.shared
    private let heartbeatStore = HeartbeatStore.shared
    private let controlChannel = ControlChannel.shared
    @State private var selectedScene: HoverScene = .chat
    @State private var isHoveringStage: Bool = false
    @State private var sceneDragOffset: CGFloat = 0
    @State private var stageHoverOffset: CGSize = .zero
    @State private var casebookSnapshot: OpenClawKit.CorrectionCasebookSnapshot =
        OpenClawKit.CorrectionCasebookStore.load()

    private var statusTitle: String {
        if let current = self.activityStore.current {
            return current.role == .main ? "Main seat" : "Support seat"
        }
        if self.activityStore.iconState.isWorking { return "Working" }
        return "Idle"
    }

    private var detail: String {
        if let current = self.activityStore.current?.label, !current.isEmpty { return current }
        if let last = self.activityStore.lastToolLabel, !last.isEmpty { return last }
        return "No active run"
    }

    private var symbolName: String {
        if self.activityStore.iconState.isWorking {
            return self.activityStore.iconState.badgeSymbolName
        }
        return "moon.zzz.fill"
    }

    private var dotColor: Color {
        if let current = self.activityStore.current {
            return current.role == .main ? .accentColor : .secondary
        }
        if self.activityStore.iconState.isWorking {
            return Color(nsColor: NSColor.systemGreen.withAlphaComponent(0.75))
        }
        return .secondary
    }

    private var healthStatusTitle: String {
        if self.healthStore.isRefreshing { return "Sync" }
        switch self.healthStore.state {
        case .ok:
            return "Ready"
        case .linkingNeeded:
            return "Link"
        case .degraded:
            return "Alert"
        case .unknown:
            return "Wait"
        }
    }

    private var healthHeadline: String {
        if self.healthStore.isRefreshing {
            return "Refreshing"
        }
        switch self.healthStore.state {
        case .ok:
            return "All linked"
        case .linkingNeeded:
            return "Link required"
        case .degraded:
            return "Needs attention"
        case .unknown:
            return "Waiting"
        }
    }

    private var healthDetail: String {
        let rawDetail: String
        if let detail = self.healthStore.detailLine, !detail.isEmpty {
            rawDetail = detail
        } else {
            rawDetail = self.healthStore.summaryLine
        }
        return self.refinedHealthDetail(rawDetail)
    }

    private func refinedHealthDetail(_ detail: String) -> String {
        let compact = detail
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = compact.lowercased()

        if lowered.contains("gateway connect") || lowered.contains("connect to gateway") {
            return "Gateway link is down. Refresh now or reopen the local connection."
        }
        if lowered.contains("timeout") {
            return "A live check timed out. Refresh to verify the current state."
        }
        if compact.count > 110 {
            return String(compact.prefix(107)).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
        }
        return compact
    }

    private var healthSymbolName: String {
        switch self.healthStore.state {
        case .ok:
            return "checkmark.circle.fill"
        case .linkingNeeded:
            return "link.badge.plus"
        case .degraded:
            return "exclamationmark.triangle.fill"
        case .unknown:
            return self.healthStore.isRefreshing ? "arrow.triangle.2.circlepath" : "waveform.path.ecg"
        }
    }

    private var healthTint: Color {
        self.healthStore.state.tint
    }

    private var heartbeatLine: String {
        if case .degraded = self.controlChannel.state {
            return "Control link down"
        }
        guard let event = self.heartbeatStore.lastEvent else {
            return "No beat"
        }

        let ageText = age(from: Date(timeIntervalSince1970: event.ts / 1000))
        switch event.status {
        case "sent":
            return "Sent \(ageText)"
        case "ok-empty", "ok-token":
            return "Beat ok \(ageText)"
        case "skipped":
            return "Skip \(ageText)"
        case "failed":
            return "Fail \(ageText)"
        default:
            return "\(event.status) \(ageText)"
        }
    }

    private var healthMetaLine: String? {
        var parts: [String] = []
        if let snap = self.healthStore.snapshot {
            let configuredChannels = snap.channels.values.filter { $0.configured == true }.count
            if configuredChannels > 0 {
                let healthyChannels = snap.channels.values.filter {
                    $0.configured == true && ($0.probe?.ok ?? true)
                }.count
                parts.append("\(healthyChannels)/\(configuredChannels) live")
            }
            parts.append("\(snap.sessions.count) seats")
            if let heartbeatSeconds = snap.heartbeatSeconds {
                parts.append("\(heartbeatSeconds)s beat")
            }
        } else if let lastSuccess = self.healthStore.lastSuccess {
            parts.append("Checked \(age(from: lastSuccess))")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var activityMetaLine: String? {
        var parts: [String] = []
        if let current = self.activityStore.current {
            parts.append(current.role == .main ? "Main" : "Support")
            parts.append(age(from: current.lastUpdate))
        } else if let lastTool = self.activityStore.lastToolUpdatedAt {
            parts.append("Tool \(age(from: lastTool))")
        }
        parts.append(self.heartbeatLine)
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var activityChipTitle: String {
        if let current = self.activityStore.current {
            return current.role == .main ? "Main" : "Assist"
        }
        if self.activityStore.iconState.isWorking { return "Live" }
        return "Idle"
    }

    private var heartbeatStatusTitle: String {
        if case .degraded = self.controlChannel.state {
            return "Drop"
        }
        guard let event = self.heartbeatStore.lastEvent else { return "Beat" }
        switch event.status {
        case "sent":
            return "Sent"
        case "ok-empty", "ok-token":
            return "Live"
        case "skipped":
            return "Skip"
        case "failed":
            return "Fail"
        default:
            return "Beat"
        }
    }

    private var heartbeatSymbolName: String {
        if case .degraded = self.controlChannel.state {
            return "bolt.horizontal.circle.fill"
        }
        guard let event = self.heartbeatStore.lastEvent else { return "heart.text.square.fill" }
        switch event.status {
        case "ok-empty", "ok-token":
            return "waveform.path.ecg.circle.fill"
        case "failed":
            return "exclamationmark.circle.fill"
        case "skipped":
            return "pause.circle.fill"
        default:
            return "heart.text.square.fill"
        }
    }

    private var heartbeatTint: Color {
        if case .degraded = self.controlChannel.state {
            return Color(nsColor: .systemRed)
        }
        guard let event = self.heartbeatStore.lastEvent else {
            return .secondary
        }
        switch event.status {
        case "ok-empty", "ok-token":
            return Color(nsColor: .systemMint)
        case "failed":
            return Color(nsColor: .systemRed)
        case "skipped":
            return Color(nsColor: .systemOrange)
        default:
            return .secondary
        }
    }

    private var activeCaseCount: Int {
        self.casebookSnapshot.activeCases.count
    }

    private var hasLiveActivity: Bool {
        self.activityStore.current != nil || self.activityStore.iconState.isWorking
    }

    private var pendingTrialCount: Int {
        CorrectionSyntheticTrialRunner.pendingRunCount(casebook: self.casebookSnapshot)
    }

    private var focusedActiveCase: OpenClawKit.CorrectionActiveCase? {
        self.casebookSnapshot.activeCases.max { lhs, rhs in
            if lhs.lastSeenAtMs == rhs.lastSeenAtMs {
                return lhs.firstSeenAtMs < rhs.firstSeenAtMs
            }
            return lhs.lastSeenAtMs < rhs.lastSeenAtMs
        }
    }

    private var casePressureTint: Color {
        if case .linkingNeeded = self.healthStore.state {
            return Color(nsColor: .systemRed)
        }
        if case .degraded = self.healthStore.state {
            return Color(nsColor: .systemOrange)
        }
        if self.activeCaseCount > 0 {
            return Color(nsColor: .systemOrange)
        }
        if self.pendingTrialCount > 0 {
            return Color(nsColor: .systemMint)
        }
        return Color(nsColor: .systemGreen)
    }

    private var casePressureTitle: String {
        if case .linkingNeeded = self.healthStore.state {
            return "Link blocked"
        }
        if case .degraded = self.healthStore.state {
            return "High pressure"
        }
        if self.activeCaseCount > 1 {
            return "High pressure"
        }
        if self.activeCaseCount == 1 {
            return "Open loop"
        }
        if self.pendingTrialCount > 0 {
            return "Trials queued"
        }
        return "Quiet"
    }

    private var casePressureDetail: String {
        if self.activeCaseCount > 0 {
            let caseLabel = self.activeCaseCount == 1 ? "open case" : "open cases"
            let trialLine = self.pendingTrialCount > 0
                ? " · \(self.pendingTrialCount) queued \(self.pendingTrialCount == 1 ? "trial" : "trials")"
                : ""
            return "\(self.activeCaseCount) \(caseLabel)\(trialLine)"
        }
        if self.pendingTrialCount > 0 {
            let trialLabel = self.pendingTrialCount == 1 ? "trial" : "trials"
            return "\(self.pendingTrialCount) queued synthetic \(trialLabel) waiting to run"
        }
        return "No active correction loops are open"
    }

    private var casePressurePillText: String {
        if self.activeCaseCount > 0 {
            return self.activeCaseCount == 1 ? "1 Case" : "\(self.activeCaseCount) Cases"
        }
        if self.pendingTrialCount > 0 {
            return self.pendingTrialCount == 1 ? "1 Trial" : "\(self.pendingTrialCount) Trials"
        }
        return "Quiet"
    }

    private var casesSceneHeadline: String {
        if let focusedActiveCase {
            return "\(self.activeCaseSeatLabel(focusedActiveCase)) needs closure"
        }
        if self.pendingTrialCount > 0 {
            let label = self.pendingTrialCount == 1 ? "trial is" : "trials are"
            return "\(self.pendingTrialCount) validation \(label) queued"
        }
        return "Verification is quiet"
    }

    private var casesSceneDetail: String {
        if let focusedActiveCase {
            let seenAt = Date(timeIntervalSince1970: Double(focusedActiveCase.lastSeenAtMs) / 1000)
            let trialLine = self.pendingTrialCount > 0
                ? " · \(self.pendingTrialCount) queued"
                : ""
            return "\(focusedActiveCase.diagnosisLabel) · seen \(age(from: seenAt))\(trialLine)"
        }
        if let nextRun = self.casebookSnapshot.nextSyntheticTrialRun() {
            return "Next: \(nextRun.templateLabel) · \(nextRun.syntheticBotLabel)"
        }
        return "Open the verification workspace and browse the casebook."
    }

    private var casesSceneMoodLine: String {
        if self.activeCaseCount > 1 {
            return "Start with the hottest open loop"
        }
        if self.activeCaseCount == 1 {
            return "One seat is waiting on closure"
        }
        if self.pendingTrialCount > 0 {
            return "Validation queue is ready"
        }
        return "Review, evidence, and follow-up"
    }

    private var casesPrimaryActionTitle: String {
        HoverHUDCasesPresentation.primaryActionTitle(
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount)
    }

    private var casesTabBadgeText: String? {
        HoverHUDCasesPresentation.tabBadgeText(
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount)
    }

    private var focusMetricValue: String {
        if let focusedActiveCase {
            return self.metricText(self.activeCaseSeatLabel(focusedActiveCase))
        }
        if let nextRun = self.casebookSnapshot.nextSyntheticTrialRun() {
            return self.metricText(nextRun.templateLabel)
        }
        return "Clear"
    }

    private var trialsMetricValue: String {
        if self.pendingTrialCount > 0 {
            return self.pendingTrialCount == 1 ? "1 queued" : "\(self.pendingTrialCount) queued"
        }
        if self.activeCaseCount > 0 {
            return "Live"
        }
        return "None"
    }

    private var coverageMetricValue: String {
        guard let snap = self.healthStore.snapshot else {
            return self.healthStatusTitle
        }
        let configuredChannels = snap.channels.values.filter { $0.configured == true }.count
        guard configuredChannels > 0 else {
            return "\(snap.sessions.count) seats"
        }
        let healthyChannels = snap.channels.values.filter {
            $0.configured == true && ($0.probe?.ok ?? true)
        }.count
        return "\(healthyChannels)/\(configuredChannels)"
    }

    private func activeCaseSeatLabel(_ activeCase: OpenClawKit.CorrectionActiveCase) -> String {
        if let label = self.casebookSnapshot.record(subjectID: activeCase.subjectID)?.label.nonEmpty {
            return label
        }
        if let suffix = activeCase.subjectID.split(separator: ":").last {
            let normalized = String(suffix).replacingOccurrences(of: "-", with: " ")
            return normalized.capitalized
        }
        return activeCase.subjectID
    }

    private func metricText(_ value: String, limit: Int = 16) -> String {
        self.clampedText(value, limit: limit)
    }

    private func summaryText(_ value: String, limit: Int = 74) -> String {
        self.clampedText(value, limit: limit)
    }

    private func clampedText(_ value: String, limit: Int) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        let index = trimmed.index(trimmed.startIndex, offsetBy: limit - 1)
        return "\(trimmed[..<index])…"
    }

    private var missionHeadline: String {
        if self.healthStore.isRefreshing {
            return "Refreshing the room"
        }
        if case .degraded = self.healthStore.state {
            return "Needs a closer look"
        }
        if case .linkingNeeded = self.healthStore.state {
            return "Connection needs a hand"
        }
        if self.activeCaseCount > 0 {
            let label = self.activeCaseCount == 1 ? "case waiting" : "cases waiting"
            return "\(self.activeCaseCount) \(label)"
        }
        if self.pendingTrialCount > 0 {
            let label = self.pendingTrialCount == 1 ? "trial queued" : "trials queued"
            return "\(self.pendingTrialCount) \(label)"
        }
        if let current = self.activityStore.current {
            return current.role == .main ? "Main session is moving" : "Support session is moving"
        }
        if self.activityStore.iconState.isWorking {
            return "Something is already in motion"
        }
        switch self.healthStore.state {
        case .ok:
            return "Start in chat"
        case .unknown:
            return "Refresh to orient the desk"
        case .degraded:
            return "Needs a closer look"
        case .linkingNeeded:
            return "Connection needs a hand"
        }
    }

    private var missionDetailText: String {
        if self.activeCaseCount > 0 || self.pendingTrialCount > 0 {
            return self.casesSceneDetail
        }
        if let current = self.activityStore.current?.label, !current.isEmpty {
            return current
        }
        if let last = self.activityStore.lastToolLabel, !last.isEmpty {
            return last
        }
        if !self.healthDetail.isEmpty {
            return self.healthDetail
        }
        return "Open chat, jump into cases, or refresh the live state."
    }

    private var primaryActionTitle: String {
        if self.hasLiveActivity {
            return "Continue in Chat"
        }
        return "Open Chat"
    }

    private var compactPrimaryAction: HoverHUDQuickActionPresentation {
        HoverHUDCompactPresentation.primaryAction(
            healthState: self.healthStore.state,
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount,
            hasLiveActivity: self.hasLiveActivity)
    }

    private var compactAlternateActionKind: HoverHUDQuickActionKind {
        switch self.compactPrimaryAction.kind {
        case .chat:
            return .cases
        case .cases, .refresh, .settings:
            return self.activeCaseCount > 0 || self.pendingTrialCount > 0 ? .cases : .chat
        }
    }

    private var compactGuidanceText: String {
        self.compactPrimaryAction.guidance
    }

    private var compactGuidanceTint: Color {
        self.quickActionTint(self.compactPrimaryAction.kind)
    }

    private var chatSceneHeadline: String {
        HoverHUDChatPresentation.headline(
            hasLiveActivity: self.hasLiveActivity,
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount)
    }

    private var chatSceneMoodLine: String {
        HoverHUDChatPresentation.moodLine(
            hasLiveActivity: self.hasLiveActivity,
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount)
    }

    private var chatSceneDetail: String {
        HoverHUDChatPresentation.detail(
            hasLiveActivity: self.hasLiveActivity,
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount,
            currentLabel: self.activityStore.current?.label)
    }

    private var chatSecondaryAction: HoverHUDQuickActionPresentation {
        HoverHUDChatPresentation.secondaryAction(
            healthState: self.healthStore.state,
            activeCaseCount: self.activeCaseCount,
            pendingTrialCount: self.pendingTrialCount)
    }

    private var ambientNoteText: String {
        if self.activeCaseCount > 0 || self.pendingTrialCount > 0 {
            return self.casesSceneDetail
        }
        if let meta = self.activityMetaLine, !meta.isEmpty {
            return meta
        }
        if let meta = self.healthMetaLine, !meta.isEmpty {
            return meta
        }
        return self.heartbeatLine
    }

    private var ambientNoteTint: Color {
        if self.activeCaseCount > 0 || self.pendingTrialCount > 0 {
            return self.casePressureTint
        }
        if self.hasLiveActivity {
            return self.dotColor
        }
        return self.healthTint
    }

    private var sceneAlertText: String? {
        if case .degraded = self.controlChannel.state {
            return self.healthDetail
        }
        switch self.healthStore.state {
        case .degraded, .linkingNeeded:
            return self.healthDetail
        case .ok, .unknown:
            return nil
        }
    }

    private var sceneAlertTitle: String {
        if case .degraded = self.controlChannel.state {
            return "Gateway Link"
        }
        switch self.healthStore.state {
        case .degraded:
            return "Needs Attention"
        case .linkingNeeded:
            return "Connection Required"
        case .ok, .unknown:
            return "Status"
        }
    }

    private var sceneAlertSymbol: String {
        if case .degraded = self.controlChannel.state {
            return "bolt.horizontal.circle.fill"
        }
        switch self.healthStore.state {
        case .degraded:
            return "exclamationmark.triangle.fill"
        case .linkingNeeded:
            return "link.badge.plus"
        case .ok:
            return "checkmark.circle.fill"
        case .unknown:
            return "waveform.path.ecg"
        }
    }

    private var sceneAlertTint: Color {
        if case .degraded = self.controlChannel.state {
            return Color(nsColor: .systemOrange)
        }
        switch self.healthStore.state {
        case .degraded:
            return Color(nsColor: .systemOrange)
        case .linkingNeeded:
            return Color(nsColor: .systemBlue)
        case .ok:
            return self.healthTint
        case .unknown:
            return .secondary
        }
    }

    private var focusedScene: HoverScene {
        self.selectedScene
    }

    private func advanceScene(by step: Int = 1) {
        let scenes = HoverScene.allCases
        guard let index = scenes.firstIndex(of: self.selectedScene) else { return }
        let count = scenes.count
        let nextIndex = (index + step % count + count) % count
        self.selectedScene = scenes[nextIndex]
    }

    private func finishSceneDrag(_ value: DragGesture.Value) {
        let finalTranslation = abs(value.predictedEndTranslation.width) > abs(value.translation.width)
            ? value.predictedEndTranslation.width
            : value.translation.width
        let threshold: CGFloat = 70

        withAnimation(.spring(response: 0.38, dampingFraction: 0.84)) {
            if finalTranslation < -threshold {
                self.advanceScene(by: 1)
            } else if finalTranslation > threshold {
                self.advanceScene(by: -1)
            }
            self.sceneDragOffset = 0
        }
    }

    private func sceneIndex(for scene: HoverScene) -> Int {
        (HoverScene.allCases.firstIndex(of: scene) ?? 0) + 1
    }

    private func sceneMoodLine(_ scene: HoverScene) -> String {
        switch scene {
        case .chat: self.chatSceneMoodLine
        case .cases: self.casesSceneMoodLine
        case .refresh: "Channel health and heartbeat"
        case .settings: "Presence and desktop behavior"
        }
    }

    private func sceneEyebrow(_ scene: HoverScene) -> String {
        switch scene {
        case .chat: "Chat"
        case .cases: "Cases"
        case .refresh: "Pulse"
        case .settings: "Studio"
        }
    }

    private func sceneTitle(_ scene: HoverScene) -> String {
        switch scene {
        case .chat:
            return self.chatSceneHeadline
        case .cases:
            return self.casesSceneHeadline
        case .refresh:
            return "Check the live pulse"
        case .settings:
            return "Tune the desktop"
        }
    }

    private func sceneSubtitle(_ scene: HoverScene) -> String {
        switch scene {
        case .chat:
            return self.summaryText(self.chatSceneDetail)
        case .cases:
            return self.summaryText(self.casesSceneDetail)
        case .refresh:
            return "Refresh channels and confirm the desk is awake."
        case .settings:
            return "Pin, collapse, and tune desk behavior."
        }
    }

    private func scenePrimaryTitle(_ scene: HoverScene) -> String {
        switch scene {
        case .chat: self.primaryActionTitle
        case .cases: self.casesPrimaryActionTitle
        case .refresh: "Refresh Now"
        case .settings: "Open Settings"
        }
    }

    private func sceneSymbol(_ scene: HoverScene) -> String {
        switch scene {
        case .chat: "bubble.left.and.bubble.right.fill"
        case .cases: "cross.case.fill"
        case .refresh: "arrow.clockwise"
        case .settings: "slider.horizontal.3"
        }
    }

    private func sceneTint(_ scene: HoverScene) -> Color {
        switch scene {
        case .chat: self.dotColor
        case .cases: self.healthTint
        case .refresh: self.heartbeatTint
        case .settings: Color(nsColor: .systemIndigo)
        }
    }

    private func sceneAccent(_ scene: HoverScene) -> Color {
        switch scene {
        case .chat: self.healthTint
        case .cases: self.dotColor
        case .refresh: self.healthTint
        case .settings: Color(nsColor: .systemBrown)
        }
    }

    private var recommendedScene: HoverScene {
        switch self.compactPrimaryAction.kind {
        case .chat:
            return .chat
        case .cases:
            return .cases
        case .refresh:
            return .refresh
        case .settings:
            return .settings
        }
    }

    private func sceneLabelAccessoryText(_ scene: HoverScene) -> String? {
        guard scene == self.recommendedScene else { return nil }
        if scene == .chat, self.healthStore.state == .ok, !self.hasLiveActivity, self.activeCaseCount == 0, self.pendingTrialCount == 0 {
            return "Start here"
        }
        return "Recommended"
    }

    private func quickActionSymbol(_ kind: HoverHUDQuickActionKind) -> String {
        switch kind {
        case .chat:
            return "bubble.left.and.bubble.right.fill"
        case .cases:
            return "cross.case.fill"
        case .refresh:
            return "arrow.clockwise"
        case .settings:
            return "slider.horizontal.3"
        }
    }

    private func quickActionTint(_ kind: HoverHUDQuickActionKind) -> Color {
        switch kind {
        case .chat:
            return self.dotColor
        case .cases:
            return self.casePressureTint
        case .refresh:
            return self.heartbeatTint
        case .settings:
            return Color(nsColor: .systemIndigo)
        }
    }

    private func quickActionHelp(_ kind: HoverHUDQuickActionKind) -> String {
        switch kind {
        case .chat:
            return self.activityStore.current != nil || self.activityStore.iconState.isWorking
                ? "Return to chat"
                : "Open chat"
        case .cases:
            return "Open verification workspace"
        case .refresh:
            return "Refresh pulse"
        case .settings:
            return "Open settings"
        }
    }

    private func performQuickAction(_ kind: HoverHUDQuickActionKind) {
        switch kind {
        case .chat:
            self.controller.openChat()
        case .cases:
            self.controller.openCorrectionWorkspace()
        case .refresh:
            self.controller.refreshHealth()
        case .settings:
            self.controller.openSettings(tab: .general)
        }
    }

    private func sceneTabAccessoryText(_ scene: HoverScene) -> String? {
        switch scene {
        case .cases:
            return self.casesTabBadgeText
        case .refresh:
            if case .degraded = self.controlChannel.state {
                return "Link"
            }
            switch self.healthStore.state {
            case .degraded:
                return "Alert"
            case .linkingNeeded:
                return "Link"
            case .ok, .unknown:
                return nil
            }
        case .chat, .settings:
            return nil
        }
    }

    private func sceneTabAccessoryTint(_ scene: HoverScene) -> Color {
        switch scene {
        case .cases:
            return self.casePressureTint
        case .refresh:
            return self.sceneAlertTint
        case .chat, .settings:
            return self.sceneTint(scene)
        }
    }

    private func sceneTabNeedsAttention(_ scene: HoverScene) -> Bool {
        switch scene {
        case .cases:
            return self.activeCaseCount > 0 || self.pendingTrialCount > 0
        case .refresh:
            if case .degraded = self.controlChannel.state {
                return true
            }
            switch self.healthStore.state {
            case .degraded, .linkingNeeded:
                return true
            case .ok, .unknown:
                return false
            }
        case .chat, .settings:
            return false
        }
    }

    @ViewBuilder
    private func sceneMetrics(for scene: HoverScene) -> some View {
        switch scene {
        case .chat:
            HoverWidgetMetricBadge(
                label: "Seat",
                value: self.statusTitle,
                tint: self.dotColor)
            HoverWidgetMetricBadge(
                label: "Beat",
                value: self.heartbeatStatusTitle,
                tint: self.heartbeatTint)

        case .cases:
            HoverWidgetMetricBadge(
                label: "Pressure",
                value: self.casePressureTitle,
                tint: self.casePressureTint)
            HoverWidgetMetricBadge(
                label: "Focus",
                value: self.focusMetricValue,
                tint: self.sceneTint(.cases))

        case .refresh:
            HoverWidgetMetricBadge(
                label: "Health",
                value: self.healthHeadline,
                tint: self.healthTint)
            HoverWidgetMetricBadge(
                label: "Channels",
                value: self.coverageMetricValue,
                tint: self.healthTint)

        case .settings:
            HoverWidgetMetricBadge(
                label: "Desk",
                value: self.controller.model.isPinned ? "Pinned" : "Floating",
                tint: Color(nsColor: .systemIndigo))
            HoverWidgetMetricBadge(
                label: "Mode",
                value: self.controller.model.isCompact ? "Compact" : "Expanded",
                tint: Color(nsColor: .systemBrown))
        }
    }

    @ViewBuilder
    private func sceneTabButton(_ scene: HoverScene) -> some View {
        HoverWidgetSceneTab(
            title: self.sceneEyebrow(scene),
            symbolName: self.sceneSymbol(scene),
            tint: self.sceneTint(scene),
            accessoryText: self.sceneTabAccessoryText(scene),
            accessoryTint: self.sceneTabAccessoryTint(scene),
            showsAttention: self.sceneTabNeedsAttention(scene),
            active: self.selectedScene == scene)
        {
            withAnimation(.spring(response: 0.30, dampingFraction: 0.84)) {
                self.selectedScene = scene
            }
        }
    }

    private func performScene(_ scene: HoverScene) {
        switch scene {
        case .chat:
            self.controller.openChat()
        case .cases:
            self.controller.openCorrectionWorkspace()
        case .refresh:
            self.controller.refreshHealth()
        case .settings:
            self.controller.openSettings(tab: .general)
        }
    }

    private func reloadCasebookSnapshot() {
        self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.load()
    }

    private func sceneSecondaryActionTitle(_ scene: HoverScene) -> String {
        switch scene {
        case .chat:
            self.chatSecondaryAction.title
        case .cases:
            "Back to Chat"
        case .refresh:
            "Tune"
        case .settings:
            self.controller.model.isPinned ? "Unpin Desk" : "Pin to Desk"
        }
    }

    private func sceneSecondaryActionSymbol(_ scene: HoverScene) -> String {
        switch scene {
        case .chat:
            self.chatSecondaryAction.systemImage
        case .cases:
            "bubble.left.and.bubble.right.fill"
        case .refresh:
            "slider.horizontal.3"
        case .settings:
            self.controller.model.isPinned ? "pin.slash" : "pin"
        }
    }

    private func performSecondarySceneAction(_ scene: HoverScene) {
        switch scene {
        case .chat:
            self.performQuickAction(self.chatSecondaryAction.kind)
        case .cases:
            self.controller.openChat()
        case .refresh:
            self.controller.openSettings(tab: .general)
        case .settings:
            self.controller.togglePinned()
        }
    }

    private func widgetBackground(cornerRadius: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.white.opacity(0.02))
            .background(
                ZStack {
                    VisualEffectView(material: .hudWindow, blendingMode: .withinWindow, emphasized: false)

                    LinearGradient(
                        colors: [
                            Color(nsColor: .windowBackgroundColor).opacity(0.36),
                            Color(nsColor: .underPageBackgroundColor).opacity(0.84),
                            Color.white.opacity(0.12),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)

                    RadialGradient(
                        colors: [
                            self.healthTint.opacity(0.08),
                            self.healthTint.opacity(0.02),
                            .clear,
                        ],
                        center: .topLeading,
                        startRadius: 20,
                        endRadius: 220)
                        .offset(x: -20, y: -18)

                    RadialGradient(
                        colors: [
                            self.dotColor.opacity(0.07),
                            self.dotColor.opacity(0.02),
                            .clear,
                        ],
                        center: .bottomTrailing,
                        startRadius: 20,
                        endRadius: 200)
                        .offset(x: 34, y: 22)

                    RoundedRectangle(cornerRadius: cornerRadius - 10, style: .continuous)
                        .fill(Color.white.opacity(0.08))
                        .frame(width: 220, height: 124)
                        .blur(radius: 0.1)
                        .offset(x: -54, y: -22)

                    RoundedRectangle(cornerRadius: cornerRadius - 14, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                        .frame(width: 188, height: 102)
                        .offset(x: 66, y: 40)

                    RoundedRectangle(cornerRadius: cornerRadius - 6, style: .continuous)
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.14),
                                    Color.white.opacity(0.04),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing),
                            lineWidth: 1)
                        .padding(7)
                }
            )
            .overlay(alignment: .topTrailing) {
                Circle()
                    .fill(self.healthTint.opacity(0.05))
                    .frame(width: 148, height: 148)
                    .blur(radius: 34)
                    .offset(x: 48, y: -46)
            }
            .overlay(alignment: .bottomLeading) {
                Circle()
                    .fill(self.dotColor.opacity(0.05))
                    .frame(width: 122, height: 122)
                    .blur(radius: 32)
                    .offset(x: -24, y: 36)
            }
    }

    private var compactBar: some View {
        HStack(spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                HoverWidgetMissionCore(
                    brandSize: 38,
                    outerTint: self.healthTint,
                    innerTint: self.dotColor,
                    accentTint: self.heartbeatTint)
                    .frame(width: 58, height: 58)

                HoverWidgetSignalDot(tint: self.ambientNoteTint)
                    .offset(x: 4, y: 2)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    HoverWidgetMiniStatusPill(
                        text: self.healthHeadline,
                        tint: self.healthTint)

                    HoverWidgetMiniStatusPill(
                        text: self.activityChipTitle,
                        tint: self.dotColor)

                    HoverWidgetMiniStatusPill(
                        text: self.casePressurePillText,
                        tint: self.casePressureTint)
                }

                Text(self.missionHeadline)
                    .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Text(self.compactGuidanceText)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(self.compactGuidanceTint)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 7) {
                HoverWidgetCompactActionButton(
                    title: self.compactPrimaryAction.title,
                    systemImage: self.compactPrimaryAction.systemImage,
                    tint: self.quickActionTint(self.compactPrimaryAction.kind))
                {
                    self.performQuickAction(self.compactPrimaryAction.kind)
                }

                HStack(spacing: 6) {
                    self.compactGlyphButton(
                        systemImage: self.quickActionSymbol(self.compactAlternateActionKind),
                        tint: self.quickActionTint(self.compactAlternateActionKind),
                        help: self.quickActionHelp(self.compactAlternateActionKind))
                    {
                        self.performQuickAction(self.compactAlternateActionKind)
                    }

                    self.compactGlyphButton(
                        systemImage: "arrow.down.right.and.arrow.up.left",
                        tint: .secondary,
                        help: "Expand panel")
                    {
                        self.controller.toggleCompact()
                    }

                    self.compactGlyphButton(
                        systemImage: "smallcircle.filled.circle.fill",
                        tint: .secondary,
                        help: "Collapse into menu bar")
                    {
                        self.controller.toggleCharm()
                    }
                }
            }
        }
    }

    private func compactGlyphButton(
        systemImage: String,
        tint: Color,
        help: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 30, height: 30)
        }
        .buttonStyle(HoverWidgetCompactGlyphButtonStyle(tint: tint))
        .help(help)
    }

    private var menuCharm: some View {
        Button {
            self.controller.expandFromCharm()
        } label: {
            ZStack {
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                self.healthTint.opacity(0.20),
                                self.dotColor.opacity(0.12),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 44, height: 44)

                Circle()
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
                    .frame(width: 44, height: 44)

                VeriClawBrandTile(size: 24)
                    .shadow(color: self.dotColor.opacity(0.14), radius: 12, y: 6)

                HoverWidgetSignalDot(tint: self.ambientNoteTint)
                    .offset(x: 17, y: -17)
            }
            .frame(width: 52, height: 52)
        }
        .buttonStyle(.plain)
        .help("Expand VeriClaw panel")
    }

    private var expandedPanel: some View {
        let scene = self.focusedScene
        let sceneTint = self.sceneTint(scene)
        let sceneAccent = self.sceneAccent(scene)

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                HStack(spacing: 10) {
                    VeriClawBrandTile(size: 30)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(Branding.shortAppName)
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(.primary)
                        Text("Desk Companion")
                            .font(.system(size: 10.5, weight: .medium, design: .rounded))
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer(minLength: 8)

                HStack(spacing: 8) {
                    Button {
                        self.controller.toggleCompact()
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 11, weight: .semibold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(HoverWidgetIconButtonStyle())
                    .help("Show desktop mini widget")

                    Button {
                        self.controller.toggleCharm()
                    } label: {
                        Image(systemName: "smallcircle.filled.circle.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(HoverWidgetIconButtonStyle())
                    .help("Collapse into menu bar")

                    Button {
                        self.controller.togglePinned()
                    } label: {
                        Image(systemName: self.controller.model.isPinned ? "pin.fill" : "pin")
                            .font(.system(size: 12, weight: .semibold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(HoverWidgetIconButtonStyle())
                    .help(self.controller.model.isPinned ? "Unpin widget" : "Pin widget")

                    Button {
                        self.controller.closeWidget()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .bold))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(HoverWidgetIconButtonStyle())
                    .help("Hide widget")
                }
            }

            GeometryReader { proxy in
                HoverWidgetSceneStage(
                    scene: scene,
                    eyebrow: self.sceneEyebrow(scene),
                    headline: self.sceneTitle(scene),
                    subheadline: self.sceneMoodLine(scene),
                    accessoryText: self.sceneLabelAccessoryText(scene),
                    stageIndex: self.sceneIndex(for: scene),
                    stageCount: HoverScene.allCases.count,
                    note: self.ambientNoteText,
                    symbolName: self.sceneSymbol(scene),
                    tint: sceneTint,
                    accent: sceneAccent,
                    ambientTint: self.ambientNoteTint,
                    isInteractive: self.isHoveringStage || abs(self.sceneDragOffset) > 6,
                    dragOffset: self.sceneDragOffset,
                    hoverOffset: self.stageHoverOffset,
                    previousAction: {
                        withAnimation(.spring(response: 0.36, dampingFraction: 0.82)) {
                            self.advanceScene(by: -1)
                        }
                    },
                    nextAction: {
                        withAnimation(.spring(response: 0.36, dampingFraction: 0.82)) {
                            self.advanceScene(by: 1)
                        }
                    })
                .contentShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
                .gesture(
                    DragGesture(minimumDistance: 8)
                        .onChanged { value in
                            self.sceneDragOffset = max(-132, min(132, value.translation.width))
                        }
                        .onEnded { value in
                            self.finishSceneDrag(value)
                        })
                .simultaneousGesture(
                    SpatialTapGesture()
                        .onEnded { value in
                            let width = max(proxy.size.width, 1)
                            if value.location.x < width * 0.33 {
                                withAnimation(.spring(response: 0.36, dampingFraction: 0.82)) {
                                    self.advanceScene(by: -1)
                                }
                            } else if value.location.x > width * 0.67 {
                                withAnimation(.spring(response: 0.36, dampingFraction: 0.82)) {
                                    self.advanceScene(by: 1)
                                }
                            } else {
                                self.performScene(scene)
                            }
                        })
                .onHover { inside in
                    withAnimation(.easeOut(duration: 0.12)) {
                        self.isHoveringStage = inside
                        self.stageHoverOffset = inside ? CGSize(width: 4, height: -2) : .zero
                    }
                }
            }
            .frame(height: 166)

            if let sceneAlertText {
                HoverWidgetStatusBanner(
                    title: self.sceneAlertTitle,
                    text: sceneAlertText,
                    systemImage: self.sceneAlertSymbol,
                    tint: self.sceneAlertTint)
            } else {
                Text(self.sceneSubtitle(scene))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.94)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    self.sceneMetrics(for: scene)
                }

                VStack(spacing: 8) {
                    self.sceneMetrics(for: scene)
                }
            }

            HStack(alignment: .center, spacing: 8) {
                HoverWidgetCapsuleActionButton(
                    title: self.scenePrimaryTitle(scene),
                    systemImage: self.sceneSymbol(scene),
                    tint: sceneTint,
                    prominence: .hero)
                {
                    self.performScene(scene)
                }

                HoverWidgetCapsuleActionButton(
                    title: self.sceneSecondaryActionTitle(scene),
                    systemImage: self.sceneSecondaryActionSymbol(scene),
                    tint: self.ambientNoteTint)
                {
                    self.performSecondarySceneAction(scene)
                }
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    ForEach(HoverScene.allCases, id: \.self) { scene in
                        self.sceneTabButton(scene)
                    }
                }

                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        ForEach(Array(HoverScene.allCases.prefix(2)), id: \.self) { scene in
                            self.sceneTabButton(scene)
                        }
                    }

                    HStack(spacing: 8) {
                        ForEach(Array(HoverScene.allCases.suffix(2)), id: \.self) { scene in
                            self.sceneTabButton(scene)
                        }
                    }
                }
            }
        }
    }

    var body: some View {
        Group {
            if self.controller.model.isCharm {
                self.menuCharm
            } else if self.controller.model.isCompact {
                self.compactBar
            } else {
                self.expandedPanel
            }
        }
        .padding(self.controller.model.isCharm ? 6 : (self.controller.model.isCompact ? 10 : 16))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(self.widgetBackground(cornerRadius: self.widgetCornerRadius))
        .overlay {
            RoundedRectangle(cornerRadius: self.widgetCornerRadius, style: .continuous)
                .strokeBorder(Color.white.opacity(self.controller.model.isCharm ? 0.10 : 0.12), lineWidth: 0.6)
        }
        .clipShape(RoundedRectangle(cornerRadius: self.widgetCornerRadius, style: .continuous))
        .shadow(
            color: Color.black.opacity(self.controller.model.isCharm ? 0.10 : (self.controller.model.isCompact ? 0.12 : 0.14)),
            radius: self.controller.model.isCharm ? 14 : (self.controller.model.isCompact ? 18 : 26),
            y: self.controller.model.isCharm ? 8 : 14)
        .shadow(
            color: Color.white.opacity(self.controller.model.isCharm ? 0.04 : 0.05),
            radius: self.controller.model.isCharm ? 6 : 10,
            y: -2)
        .contentShape(RoundedRectangle(cornerRadius: self.widgetCornerRadius, style: .continuous))
        .onHover { inside in
            self.controller.panelHoverChanged(inside: inside)
        }
        .onAppear {
            self.reloadCasebookSnapshot()
        }
        .onChange(of: self.selectedScene) { _, newValue in
            if newValue == .cases {
                self.reloadCasebookSnapshot()
            }
        }
    }

    private var widgetCornerRadius: CGFloat {
        if self.controller.model.isCharm {
            return 24
        }
        if self.controller.model.isCompact {
            return 22
        }
        return 28
    }
}

private struct HoverWidgetMissionCore: View {
    let brandSize: CGFloat
    let outerTint: Color
    let innerTint: Color
    let accentTint: Color
    @State private var isBreathing = false

    var body: some View {
        let lateralDrift: CGFloat = self.isBreathing ? 3 : -2
        let verticalDrift: CGFloat = self.isBreathing ? -2 : 2
        let softTilt: CGFloat = self.isBreathing ? 2.2 : -1.4
        let pulse: CGFloat = self.isBreathing ? 1.018 : 0.992

        ZStack {
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.14),
                            Color.white.opacity(0.05),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: 120, height: 136)
                .overlay(
                    RoundedRectangle(cornerRadius: 34, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                .offset(x: -12 + (lateralDrift * 0.35), y: 10 + (verticalDrift * 0.2))
                .rotationEffect(.degrees(-7 + Double(softTilt * 0.35)))

            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            self.outerTint.opacity(0.18),
                            self.innerTint.opacity(0.06),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: 104, height: 122)
                .overlay(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
                .offset(x: 20 - (lateralDrift * 0.22), y: -10 + (verticalDrift * 0.26))
                .rotationEffect(.degrees(8 + Double(softTilt * 0.3)))

            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            self.outerTint.opacity(0.14),
                            self.outerTint.opacity(0.05),
                            .clear,
                        ],
                        center: .center,
                        startRadius: 6,
                        endRadius: 72))
                .scaleEffect(pulse)
                .offset(x: 6, y: -4)

            VeriClawBrandTile(size: self.brandSize)
                .scaleEffect(pulse)
                .rotationEffect(.degrees(Double(softTilt)))
                .shadow(color: self.innerTint.opacity(0.10), radius: 20, y: 10)
                .offset(x: lateralDrift * 0.24, y: verticalDrift * 0.22)

            Capsule(style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.42),
                            Color.white.opacity(0.02),
                        ],
                        startPoint: .leading,
                        endPoint: .trailing))
                .frame(width: 86, height: 14)
                .blur(radius: 1.4)
                .rotationEffect(.degrees(-18))
                .offset(x: 12, y: -34)

            HoverWidgetSignalDot(tint: self.outerTint)
                .offset(x: 42, y: -52)
            HoverWidgetSignalDot(tint: self.innerTint)
                .offset(x: -50, y: 34)
            HoverWidgetSignalDot(tint: self.accentTint)
                .offset(x: 52, y: 44)
        }
        .onAppear {
            guard !ProcessInfo.processInfo.isRunningTests else { return }
            guard !self.isBreathing else { return }
            withAnimation(.easeInOut(duration: 5.6).repeatForever(autoreverses: true)) {
                self.isBreathing = true
            }
        }
    }
}

private struct HoverWidgetSceneStage: View {
    let scene: HoverScene
    let eyebrow: String
    let headline: String
    let subheadline: String
    let accessoryText: String?
    let stageIndex: Int
    let stageCount: Int
    let note: String
    let symbolName: String
    let tint: Color
    let accent: Color
    let ambientTint: Color
    let isInteractive: Bool
    let dragOffset: CGFloat
    let hoverOffset: CGSize
    let previousAction: () -> Void
    let nextAction: () -> Void

    var body: some View {
        let driftX: CGFloat = 0
        let driftY: CGFloat = 0
        let pulse: CGFloat = 1

        ZStack {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0.20),
                            self.tint.opacity(0.10),
                            self.accent.opacity(0.06),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .overlay(
                    RoundedRectangle(cornerRadius: 30, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))

            Circle()
                .fill(self.tint.opacity(0.12))
                .frame(width: 188, height: 188)
                .blur(radius: 24)
                .offset(x: -116 + driftX, y: -46 + (driftY * 0.4))

            Circle()
                .fill(self.accent.opacity(0.10))
                .frame(width: 168, height: 168)
                .blur(radius: 24)
                .offset(x: 134 - (driftX * 0.75), y: 58 - (driftY * 0.5))

            self.sceneComposition(driftX: driftX, driftY: driftY, pulse: pulse)
                .offset(
                    x: self.dragOffset * 0.14 + (self.hoverOffset.width * 0.12),
                    y: self.hoverOffset.height * 0.08)
                .scaleEffect(1 + (abs(self.dragOffset) / 6200))

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    HoverWidgetSceneLabel(
                        title: self.eyebrow,
                        symbolName: self.symbolName,
                        tint: self.tint,
                        accessoryText: self.accessoryText)

                    Spacer(minLength: 0)

                    VStack(alignment: .trailing, spacing: 6) {
                        HoverWidgetStageStepper(
                            currentIndex: self.stageIndex,
                            count: self.stageCount,
                            tint: self.tint,
                            accent: self.accent,
                            visible: self.isInteractive,
                            previousAction: self.previousAction,
                            nextAction: self.nextAction)

                        HoverWidgetStageInteractionHint(
                            text: "Tap to open · swipe to switch",
                            tint: self.tint,
                            visible: self.isInteractive)
                    }
                }

                Spacer(minLength: 0)

                HStack(alignment: .bottom, spacing: 10) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(self.headline)
                            .font(.system(size: 23, weight: .semibold, design: .serif))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)

                        Text(self.subheadline)
                            .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                            .foregroundStyle(self.tint.opacity(0.90))
                            .lineLimit(1)

                        HStack(spacing: 8) {
                            HoverWidgetSignalDot(tint: self.ambientTint)
                            Text(self.note)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(
                            Capsule(style: .continuous)
                                .fill(Color.white.opacity(0.18))
                                .overlay(
                                    Capsule(style: .continuous)
                                        .strokeBorder(self.ambientTint.opacity(0.12), lineWidth: 1)))
                    }
                    .offset(x: self.hoverOffset.width * 0.12, y: self.hoverOffset.height * 0.06)

                    Spacer(minLength: 0)

                    VeriClawBrandTile(size: 34)
                        .scaleEffect(pulse + (abs(self.hoverOffset.width) / 240))
                        .rotationEffect(.degrees(Double((driftX * 0.1) + (self.hoverOffset.width * 0.1))))
                }
            }
            .padding(14)

        }
        .frame(maxWidth: .infinity)
        .frame(height: 166)
    }

    @ViewBuilder
    private func sceneComposition(driftX: CGFloat, driftY: CGFloat, pulse: CGFloat) -> some View {
        switch self.scene {
        case .chat:
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.white.opacity(0.16))
                    .frame(width: 148, height: 88)
                    .overlay(alignment: .topLeading) {
                        HoverWidgetSceneBars(
                            widths: [74, 54, 64],
                            tint: Color.white.opacity(0.78))
                        .padding(16)
                    }
                    .offset(x: -64 + (driftX * 0.25), y: -4 + (driftY * 0.14))
                    .rotationEffect(.degrees(-7))

                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                self.tint.opacity(0.26),
                                self.accent.opacity(0.12),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 132, height: 78)
                    .overlay(alignment: .topLeading) {
                        HoverWidgetSceneBars(
                            widths: [66, 48, 38],
                            tint: self.tint.opacity(0.88))
                        .padding(14)
                    }
                    .offset(x: 76 - (driftX * 0.18), y: 22 - (driftY * 0.18))
                    .rotationEffect(.degrees(8))
            }

        case .cases:
            ZStack {
                ForEach(Array([0, 1, 2].enumerated()), id: \.offset) { index, offsetIndex in
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Color.white.opacity(0.10 + (Double(index) * 0.03)))
                        .frame(width: 130, height: 82)
                        .overlay(alignment: .topLeading) {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(self.tint.opacity(0.22))
                                    .frame(width: 26, height: 26)
                                    .overlay(
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 10, weight: .bold))
                                            .foregroundStyle(self.tint))

                                HoverWidgetSceneBars(
                                    widths: [54, 42],
                                    tint: Color.white.opacity(0.70))
                            }
                            .padding(16)
                        }
                        .offset(
                            x: -22 + CGFloat(offsetIndex * 30) + (driftX * (0.08 + (CGFloat(index) * 0.04))),
                            y: -14 + CGFloat(offsetIndex * 12) + (driftY * 0.12))
                        .rotationEffect(.degrees(Double(-6 + (offsetIndex * 5))))
                }
            }

        case .refresh:
            ZStack {
                Circle()
                    .strokeBorder(self.tint.opacity(0.28), lineWidth: 10)
                    .frame(width: 106, height: 106)
                    .scaleEffect(pulse)

                Circle()
                    .strokeBorder(self.accent.opacity(0.32), lineWidth: 5)
                    .frame(width: 138, height: 138)
                    .scaleEffect(1.02 - ((pulse - 1) * 0.5))

                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 164, height: 46)
                    .overlay {
                        HStack(spacing: 9) {
                            ForEach(0..<7, id: \.self) { bar in
                                Capsule(style: .continuous)
                                    .fill(self.tint.opacity(0.84 - (Double(bar) * 0.07)))
                                    .frame(width: 7, height: 10 + CGFloat((bar % 3) * 8))
                            }
                        }
                    }
                    .offset(x: 0, y: 10 + (driftY * 0.08))
            }

        case .settings:
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .fill(Color.white.opacity(0.12))
                    .frame(width: 164, height: 96)
                    .overlay(alignment: .topLeading) {
                        VStack(alignment: .leading, spacing: 14) {
                            HoverWidgetSliderGlyph(tint: self.tint, accent: self.accent, knobOffset: 0.20)
                            HoverWidgetSliderGlyph(tint: self.accent, accent: self.tint, knobOffset: 0.72)
                            HoverWidgetSliderGlyph(tint: self.ambientTint, accent: self.tint, knobOffset: 0.48)
                        }
                        .padding(18)
                    }
                    .offset(x: -36 + (driftX * 0.16), y: 2 + (driftY * 0.10))
                    .rotationEffect(.degrees(-6))

                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(self.tint.opacity(0.16))
                    .frame(width: 74, height: 74)
                    .overlay {
                        Image(systemName: "dial.low.fill")
                            .font(.system(size: 26, weight: .medium))
                            .foregroundStyle(self.tint)
                    }
                    .offset(x: 96 - (driftX * 0.22), y: 24 - (driftY * 0.12))
                    .rotationEffect(.degrees(9))
            }
        }
    }
}

private struct HoverWidgetSceneBars: View {
    let widths: [CGFloat]
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(self.widths.enumerated()), id: \.offset) { _, width in
                Capsule(style: .continuous)
                    .fill(self.tint)
                    .frame(width: width, height: 7)
            }
        }
    }
}

private struct HoverWidgetSliderGlyph: View {
    let tint: Color
    let accent: Color
    let knobOffset: CGFloat

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let x = max(10, min(width - 10, width * self.knobOffset))

            ZStack(alignment: .leading) {
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.22))
                    .frame(height: 6)

                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [self.tint, self.accent.opacity(0.8)],
                            startPoint: .leading,
                            endPoint: .trailing))
                    .frame(width: x, height: 6)

                Circle()
                    .fill(Color.white.opacity(0.94))
                    .frame(width: 14, height: 14)
                    .shadow(color: self.tint.opacity(0.22), radius: 6, y: 3)
                    .offset(x: x - 7)
            }
        }
        .frame(height: 14)
    }
}

private struct HoverWidgetStatusBanner: View {
    let title: String
    let text: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                Circle()
                    .fill(self.tint.opacity(0.18))
                    .frame(width: 28, height: 28)
                Image(systemName: self.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(self.tint)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(self.tint)

                Text(self.text)
                    .font(.system(size: 11.5, weight: .medium, design: .rounded))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(self.tint.opacity(0.12), lineWidth: 1)))
    }
}

private struct HoverWidgetMetricBadge: View {
    let label: String
    let value: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.value)
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
            Text(self.label)
                .font(.system(size: 10.5, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(self.tint.opacity(0.10))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(self.tint.opacity(0.10), lineWidth: 1)))
    }
}

private struct HoverWidgetSceneLabel: View {
    let title: String
    let symbolName: String
    let tint: Color
    var accessoryText: String? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: self.symbolName)
                .font(.system(size: 10, weight: .semibold))
            Text(self.title)
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.84)
            if let accessoryText, !accessoryText.isEmpty {
                Text(accessoryText)
                    .font(.system(size: 8.5, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(
                        Capsule(style: .continuous)
                            .fill(self.tint.opacity(0.16))
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(self.tint.opacity(0.12), lineWidth: 1)))
            }
        }
        .foregroundStyle(self.tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.16))
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(self.tint.opacity(0.10), lineWidth: 1)))
    }
}

private struct HoverWidgetStageStepper: View {
    let currentIndex: Int
    let count: Int
    let tint: Color
    let accent: Color
    let visible: Bool
    let previousAction: () -> Void
    let nextAction: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            HoverWidgetStageNavButton(
                systemImage: "chevron.left",
                tint: self.tint,
                visible: self.visible,
                action: self.previousAction)

            HStack(spacing: 6) {
                ForEach(0..<self.count, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(
                            index + 1 == self.currentIndex
                                ? self.tint.opacity(0.92)
                                : Color.white.opacity(self.visible ? 0.28 : 0.14))
                        .frame(width: index + 1 == self.currentIndex ? 16 : 6, height: 6)
                        .overlay(
                            Capsule(style: .continuous)
                                .strokeBorder(
                                    (index + 1 == self.currentIndex ? self.accent : .white).opacity(0.12),
                                    lineWidth: 1))
                        .animation(.spring(response: 0.24, dampingFraction: 0.82), value: self.currentIndex)
                }
            }
            .padding(.horizontal, 4)

            HoverWidgetStageNavButton(
                systemImage: "chevron.right",
                tint: self.accent,
                visible: self.visible,
                action: self.nextAction)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.16))
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)))
    }
}

private struct HoverWidgetStageInteractionHint: View {
    let text: String
    let tint: Color
    let visible: Bool

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "hand.tap")
                .font(.system(size: 8.5, weight: .semibold))
            Text(self.text)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.84)
        }
        .foregroundStyle(self.visible ? self.tint.opacity(0.92) : .secondary)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(self.visible ? 0.14 : 0.10))
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(self.tint.opacity(self.visible ? 0.12 : 0.08), lineWidth: 1)))
        .opacity(self.visible ? 1 : 0.84)
    }
}

private struct HoverWidgetStageNavButton: View {
    let systemImage: String
    let tint: Color
    let visible: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(self.tint)
                .frame(width: 24, height: 24)
                .background(
                    Circle()
                        .fill(Color.white.opacity(self.visible ? 0.22 : 0.10))
                        .overlay(
                            Circle()
                                .strokeBorder(self.tint.opacity(self.visible ? 0.18 : 0.08), lineWidth: 1)))
        }
        .buttonStyle(.plain)
        .opacity(self.visible ? 1 : 0.36)
        .scaleEffect(self.visible ? 1 : 0.94)
        .animation(.easeOut(duration: 0.16), value: self.visible)
    }
}

private struct HoverWidgetSignalDot: View {
    let tint: Color

    var body: some View {
        Circle()
            .fill(self.tint.opacity(0.92))
            .frame(width: 7, height: 7)
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(0.55), lineWidth: 1)
                    .padding(-2))
            .shadow(color: self.tint.opacity(0.18), radius: 8, y: 4)
    }
}

private struct HoverWidgetCompactActionButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 5) {
                Image(systemName: self.systemImage)
                    .font(.system(size: 10, weight: .semibold))
                Text(self.title)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.84)
            }
            .foregroundStyle(self.tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                Capsule(style: .continuous)
                    .fill(Color.white.opacity(0.10))
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSecondaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetMiniStatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(self.text)
            .font(.system(size: 9.5, weight: .semibold, design: .rounded))
            .foregroundStyle(self.tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                Capsule(style: .continuous)
                    .fill(self.tint.opacity(0.12))
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(self.tint.opacity(0.12), lineWidth: 1)))
    }
}

private struct HoverWidgetCapsuleActionButton: View {
    enum Prominence {
        case standard
        case hero
    }

    let title: String
    let systemImage: String
    let tint: Color
    var prominence: Prominence = .standard
    let action: () -> Void

    private var capsuleFill: AnyShapeStyle {
        if self.prominence == .hero {
            AnyShapeStyle(
                LinearGradient(
                    colors: [
                        self.tint.opacity(0.24),
                        self.tint.opacity(0.14),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing))
        } else {
            AnyShapeStyle(Color.white.opacity(0.10))
        }
    }

    private var strokeTint: Color {
        self.prominence == .hero ? self.tint.opacity(0.30) : Color.white.opacity(0.08)
    }

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 7) {
                Image(systemName: self.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(self.title)
                    .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                    .lineLimit(1)
            }
            .foregroundStyle(self.tint)
            .padding(.horizontal, self.prominence == .hero ? 14 : 12)
            .padding(.vertical, 9)
            .background(
                Capsule(style: .continuous)
                    .fill(self.capsuleFill)
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(self.strokeTint, lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSecondaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetSceneAccessoryButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 8) {
                Image(systemName: self.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(self.title)
                    .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                    .lineLimit(1)
            }
            .foregroundStyle(self.tint)
            .frame(maxWidth: .infinity, minHeight: 28)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color.white.opacity(0.09))
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSecondaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetSceneTab: View {
    let title: String
    let symbolName: String
    let tint: Color
    let accessoryText: String?
    let accessoryTint: Color
    let showsAttention: Bool
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 7) {
                Image(systemName: self.symbolName)
                    .font(.system(size: 10.5, weight: .semibold))
                Text(self.title)
                    .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                if let accessoryText, !accessoryText.isEmpty {
                    Text(accessoryText)
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(self.active ? self.tint : self.accessoryTint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.84)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(
                            Capsule(style: .continuous)
                                .fill((self.active ? self.tint : self.accessoryTint).opacity(0.14)))
                }
            }
            .foregroundStyle(self.active ? self.tint : .secondary)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
            .background(
                Capsule(style: .continuous)
                    .fill(self.active ? self.tint.opacity(0.16) : (self.showsAttention ? self.accessoryTint.opacity(0.10) : Color.white.opacity(0.10)))
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(self.active ? self.tint.opacity(0.18) : (self.showsAttention ? self.accessoryTint.opacity(0.16) : Color.white.opacity(0.08)), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSecondaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetOrbitCard: View {
    let title: String
    let subtitle: String
    let symbolName: String
    let tint: Color
    let accent: Color
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    ZStack {
                        Circle()
                            .fill(self.tint.opacity(self.active ? 0.20 : 0.10))
                            .frame(width: 34, height: 34)
                        Image(systemName: self.symbolName)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(self.tint)
                    }

                    Spacer(minLength: 0)

                    VeriClawBrandTile(size: 18)
                        .opacity(self.active ? 1 : 0.78)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(self.title)
                        .font(.system(size: 9.5, weight: .bold, design: .rounded))
                        .kerning(0.8)
                        .foregroundStyle(self.tint)
                    Text(self.subtitle)
                        .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                }
            }
            .frame(width: 132)
            .frame(minHeight: 90, alignment: .topLeading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                self.tint.opacity(self.active ? 0.20 : 0.08),
                                self.accent.opacity(self.active ? 0.14 : 0.05),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(Color.white.opacity(self.active ? 0.14 : 0.08), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSceneCardButtonStyle(tint: self.tint, active: self.active))
    }
}

private struct HoverWidgetPrimaryActionButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(self.title)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(.primary)
                    Text(self.subtitle)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                ZStack {
                    Circle()
                        .fill(self.tint.opacity(0.16))
                        .frame(width: 38, height: 38)
                    Image(systemName: self.systemImage)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(self.tint)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.white.opacity(0.10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.09), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetPrimaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetActionTile: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(self.tint.opacity(0.12))
                        .frame(width: 40, height: 40)
                    Image(systemName: self.systemImage)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(self.tint)
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(self.title)
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.primary)
                    Text(self.subtitle)
                        .font(.system(size: 10.5, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSecondaryButtonStyle(tint: self.tint))
    }
}

private struct HoverWidgetSceneCard: View {
    let title: String
    let subtitle: String
    let symbolName: String
    let tint: Color
    let accent: Color
    let isSelected: Bool
    let isPreviewing: Bool
    let action: () -> Void

    private var active: Bool {
        self.isSelected || self.isPreviewing
    }

    var body: some View {
        Button(action: self.action) {
            VStack(alignment: .leading, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    self.tint.opacity(self.active ? 0.22 : 0.09),
                                    self.accent.opacity(self.active ? 0.16 : 0.05),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                        .frame(height: 52)
                        .overlay(
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .strokeBorder(Color.white.opacity(self.active ? 0.12 : 0.08), lineWidth: 1))

                    Circle()
                        .fill(self.tint.opacity(self.active ? 0.20 : 0.10))
                        .frame(width: 42, height: 42)
                        .blur(radius: 10)
                        .offset(x: 34, y: 18)

                    VeriClawBrandTile(size: 20)
                        .offset(x: 50, y: 10)
                        .scaleEffect(self.active ? 1.03 : 0.98)

                    Image(systemName: self.symbolName)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(self.tint)
                        .padding(12)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(self.title)
                        .font(.system(size: 9.5, weight: .bold, design: .rounded))
                        .kerning(0.8)
                        .foregroundStyle(self.tint)
                    Text(self.subtitle)
                        .font(.system(size: 11.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 94, alignment: .topLeading)
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color.white.opacity(self.active ? 0.12 : 0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.white.opacity(self.active ? 0.12 : 0.08), lineWidth: 1)))
        }
        .buttonStyle(HoverWidgetSceneCardButtonStyle(tint: self.tint, active: self.active))
    }
}

private struct HoverWidgetPrimaryButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.982 : 1)
            .overlay(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(self.tint.opacity(configuration.isPressed ? 0.26 : 0.12), lineWidth: 1))
            .shadow(
                color: self.tint.opacity(configuration.isPressed ? 0.06 : 0.10),
                radius: configuration.isPressed ? 10 : 16,
                y: configuration.isPressed ? 6 : 10)
            .opacity(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct HoverWidgetSecondaryButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(self.tint.opacity(configuration.isPressed ? 0.22 : 0.10), lineWidth: 1))
            .shadow(
                color: self.tint.opacity(configuration.isPressed ? 0.04 : 0.07),
                radius: configuration.isPressed ? 8 : 12,
                y: configuration.isPressed ? 4 : 7)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct HoverWidgetSceneCardButtonStyle: ButtonStyle {
    let tint: Color
    let active: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.982 : (self.active ? 1.01 : 1))
            .shadow(
                color: self.tint.opacity(self.active ? 0.12 : 0.05),
                radius: self.active ? 18 : 10,
                y: self.active ? 12 : 8)
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: configuration.isPressed)
            .animation(.spring(response: 0.35, dampingFraction: 0.82), value: self.active)
    }
}

private struct HoverWidgetIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.secondary)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.20 : 0.12))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.92 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct HoverWidgetCompactGlyphButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(self.tint)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(configuration.isPressed ? 0.24 : 0.14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(self.tint.opacity(configuration.isPressed ? 0.20 : 0.10), lineWidth: 1)))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
