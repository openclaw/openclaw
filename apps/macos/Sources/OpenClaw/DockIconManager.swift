import AppKit

protocol DockVisibilityPromotingPanel {}

/// Central manager for Dock icon visibility.
/// Shows the Dock icon while any windows are visible, regardless of user preference.
final class DockIconManager: NSObject, @unchecked Sendable {
    static let shared = DockIconManager()

    private var windowsObservation: NSKeyValueObservation?
    private let logger = Logger(subsystem: "ai.openclaw", category: "DockIconManager")

    override private init() {
        super.init()
        self.setupObservers()
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    deinit {
        self.windowsObservation?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    @MainActor
    func updateDockVisibilityNow() {
        guard NSApp != nil else {
            self.logger.warning("NSApp not ready, skipping Dock visibility update")
            return
        }

        let userWantsDockHidden = !UserDefaults.standard.bool(forKey: showDockIconKey)
        let visibleWindows = NSApp?.windows ?? []
        let shouldUseRegularActivation = Self.shouldUseRegularActivation(
            userWantsDockHidden: userWantsDockHidden,
            windows: visibleWindows)

        if shouldUseRegularActivation {
            NSApp?.setActivationPolicy(.regular)
        } else {
            NSApp?.setActivationPolicy(.accessory)
        }
    }

    func updateDockVisibility() {
        Task { @MainActor in
            self.updateDockVisibilityNow()
        }
    }

    @MainActor
    func temporarilyShowDockNow() {
        guard NSApp != nil else {
            self.logger.warning("NSApp not ready, cannot show Dock icon")
            return
        }
        NSApp.setActivationPolicy(.regular)
    }

    func temporarilyShowDock() {
        Task { @MainActor in
            self.temporarilyShowDockNow()
        }
    }

    @MainActor
    static func shouldUseRegularActivation(userWantsDockHidden: Bool, windows: [NSWindow]) -> Bool {
        if !userWantsDockHidden {
            return true
        }
        return windows.contains(where: self.countsAsPrimaryAppWindow)
    }

    @MainActor
    static func countsAsPrimaryAppWindow(_ window: NSWindow) -> Bool {
        guard window.isVisible, window.frame.width > 1, window.frame.height > 1 else {
            return false
        }

        if "\(type(of: window))" == "NSPopupMenuWindow" {
            return false
        }

        if window is DockVisibilityPromotingPanel {
            return true
        }

        if window.isKind(of: NSPanel.self) {
            return false
        }

        return window.contentViewController != nil || window.contentView != nil
    }

    private func setupObservers() {
        Task { @MainActor in
            guard let app = NSApp else {
                self.logger.warning("NSApp not ready, delaying Dock observers")
                try? await Task.sleep(for: .milliseconds(200))
                self.setupObservers()
                return
            }

            self.windowsObservation = app.observe(\.windows, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(50))
                    self?.updateDockVisibility()
                }
            }

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didBecomeKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.didResignKeyNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.windowVisibilityChanged),
                name: NSWindow.willCloseNotification,
                object: nil)
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.dockPreferenceChanged),
                name: UserDefaults.didChangeNotification,
                object: nil)
        }
    }

    @objc
    private func windowVisibilityChanged(_: Notification) {
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    @objc
    private func dockPreferenceChanged(_ notification: Notification) {
        guard let userDefaults = notification.object as? UserDefaults,
              userDefaults == UserDefaults.standard
        else { return }

        Task { @MainActor in
            self.updateDockVisibility()
        }
    }
}
