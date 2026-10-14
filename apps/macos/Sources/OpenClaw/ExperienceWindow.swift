import AppKit

class ExperienceWindow: NSWindow {
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
