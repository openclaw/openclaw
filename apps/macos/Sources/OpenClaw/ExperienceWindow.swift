import AppKit

class ExperienceWindow: NSWindow {
    private var contentZoomWebView: DashboardWebView? {
        guard self.attachedSheet == nil else { return nil }
        func find(in view: NSView) -> DashboardWebView? {
            guard !view.isHidden else { return nil }
            if let webView = view as? DashboardWebView { return webView }
            return view.subviews.lazy.compactMap { find(in: $0) }.first
        }
        return self.contentView.flatMap { find(in: $0) }
    }

    @objc func zoomContentIn(_: Any?) { self.contentZoomWebView?.changeContentZoom(by: 1) }
    @objc func zoomContentOut(_: Any?) { self.contentZoomWebView?.changeContentZoom(by: -1) }
    @objc func resetContentZoom(_: Any?) { self.contentZoomWebView?.setContentZoom(1) }

    override func becomeKey() {
        super.becomeKey()
        guard !self.isHiddenForExperience else { return }
        self.contentZoomWebView?.finishContentZoomInitialization()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard self.contentZoomWebView != nil,
              event.type == .keyDown,
              event.modifierFlags.intersection([.command, .control, .option]) == .command,
              let key = event.charactersIgnoringModifiers else { return super.performKeyEquivalent(with: event) }
        switch key {
        case "=", "+": self.zoomContentIn(nil)
        case "-" where !event.modifierFlags.contains(.shift): self.zoomContentOut(nil)
        case "0" where !event.modifierFlags.contains(.shift): self.resetContentZoom(nil)
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    var isHiddenForExperience = false {
        didSet {
            NotificationCenter.default.removeObserver(
                self, name: NSWindow.didDeminiaturizeNotification, object: self)
            guard self.isHiddenForExperience else { return }
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.finishExperienceDeminiaturization(_:)),
                name: NSWindow.didDeminiaturizeNotification,
                object: self)
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func finishExperienceDeminiaturization(_: Notification) {
        // AppKit orders the window on-screen after this notification returns.
        // Window-owned intent survives document replacement; a later show clears it.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isHiddenForExperience else { return }
            self.orderOut(nil)
        }
    }
}
