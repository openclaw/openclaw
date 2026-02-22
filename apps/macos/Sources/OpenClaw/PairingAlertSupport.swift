import AppKit

final class PairingAlertHostWindow: NSWindow {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

@MainActor
enum PairingAlertSupport {
    static func endActiveAlert(activeAlert: inout NSAlert?, activeRequestId: inout String?) {
        guard let alert = activeAlert else { return }
        if let parent = alert.window.sheetParent {
            parent.endSheet(alert.window, returnCode: .abort)
        }
        activeAlert = nil
        activeRequestId = nil
    }

    static func requireAlertHostWindow(alertHostWindow: inout NSWindow?) -> NSWindow {
        if let alertHostWindow {
            return alertHostWindow
        }

        let window = PairingAlertHostWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 1),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)
        window.title = ""
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        window.hasShadow = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true

        alertHostWindow = window
        return window
    }
}
