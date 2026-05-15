import AppKit
import Foundation

enum AmbientOverlayHotkeyMatcher {
    static let spaceKeyCode: UInt16 = 49

    static func matches(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) -> Bool {
        guard keyCode == Self.spaceKeyCode else { return false }
        guard modifierFlags.contains(.control), modifierFlags.contains(.option) else { return false }
        guard !modifierFlags.contains(.command), !modifierFlags.contains(.shift) else { return false }
        return true
    }
}

@MainActor
final class AmbientOverlayHotkeyController {
    static let shared = AmbientOverlayHotkeyController()

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private(set) var isEnabled = false

    private init() {}

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if ProcessInfo.processInfo.isRunningTests { return }

        if enabled {
            self.install()
        } else {
            self.remove()
        }
    }

    func install() {
        guard self.globalMonitor == nil, self.localMonitor == nil else { return }
        self.isEnabled = true

        self.globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            guard AmbientOverlayHotkeyMatcher.matches(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags)
            else { return }

            Task { @MainActor in
                AmbientOverlayExperienceController.shared.toggleArmed()
            }
        }

        self.localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard AmbientOverlayHotkeyMatcher.matches(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags)
            else { return event }

            Task { @MainActor in
                AmbientOverlayExperienceController.shared.toggleArmed()
            }
            return nil
        }
    }

    func remove() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
            self.localMonitor = nil
        }
        self.isEnabled = false
    }
}
