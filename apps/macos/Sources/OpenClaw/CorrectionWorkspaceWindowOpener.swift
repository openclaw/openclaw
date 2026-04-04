import AppKit

@MainActor
final class CorrectionWorkspaceWindowOpener {
    static let shared = CorrectionWorkspaceWindowOpener()

    func open() {
        DockIconManager.shared.temporarilyShowDockNow()
        NSApp.activate(ignoringOtherApps: true)
        NSRunningApplication.current.activate(options: [.activateAllWindows])
        let sessionKey = WebChatManager.shared.preferredSessionKeyImmediate()
        WebChatManager.shared.show(sessionKey: sessionKey, mode: .correction)
        WebChatManager.shared.warmPreferredSessionKey()
    }
}
