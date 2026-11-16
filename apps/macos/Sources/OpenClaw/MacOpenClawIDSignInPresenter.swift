import AppKit
import SwiftUI

/// The Settings, dashboard recovery and menu entry points share one sign-in sheet.
@MainActor
final class MacOpenClawIDSignInPresenter: NSObject, NSWindowDelegate {
    static let shared = MacOpenClawIDSignInPresenter()
    private var window: NSWindow?

    func present() {
        if let window = self.window {
            AppActivation.shared.makeKeyAndOrderFront(window: window)
            return
        }
        let model = OnboardingOpenClawIDModel(
            service: OnboardingOpenClawIDSignInService(),
            onJoined: { [weak self] claw in
                try MacOpenClawIDJoinCompletion.finish(claw: claw)
                self?.close()
            })
        let window = NSWindow(
            contentRect: .zero, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "OpenClaw ID"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: OnboardingOpenClawIDView(
            model: model, onClose: { [weak self] in self?.close() }))
        window.center()
        self.window = window
        model.begin(.connect)
        if let parent = NSApp.keyWindow {
            parent.beginSheet(window) { [weak self] _ in self?.close() }
        } else {
            AppActivation.shared.makeKeyAndOrderFront(window: window)
        }
    }

    func windowWillClose(_ notification: Notification) {
        self.close()
    }

    private func close() {
        guard let window = self.window else { return }
        self.window = nil
        window.sheetParent?.endSheet(window)
        window.contentView = nil
        window.close()
    }
}
