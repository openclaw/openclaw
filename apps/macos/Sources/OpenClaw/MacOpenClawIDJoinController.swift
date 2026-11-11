import AppKit
import SwiftUI

/// Adds this Mac to a claw outside first-run onboarding: from Settings, or from an
/// `openclaw-node://join` link the owner shared. Success opens the claw's dashboard.
@MainActor
final class MacOpenClawIDJoinController: NSWindowController, NSWindowDelegate {
    static let shared = MacOpenClawIDJoinController()
    private var model: OnboardingOpenClawIDModel?

    private init() {
        super.init(window: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Opens the join sheet, optionally with an invitation already in the paste field.
    func present(invitation: String? = nil) {
        if let model, let window, window.isVisible {
            // A new link replaces an unfinished attempt; an attempt in progress keeps its code.
            if model.step == .nodeInvitation, let invitation { model.pendingInvitation = invitation }
            AppActivation.shared.makeKeyAndOrderFront(window: window)
            AppActivation.shared.activate()
            return
        }
        let model = OnboardingOpenClawIDModel(service: OnboardingNodeInvitationService())
        model.begin(.joinNode)
        model.pendingInvitation = invitation
        self.model = model
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 574, height: 520),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        window.title = String(localized: "Add this Mac to a claw")
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: MacOpenClawIDJoinView(
            model: model,
            onConnected: { [weak self] in
                self?.close()
                AppNavigationActions.openDashboard()
            }))
        self.window = window
        window.center()
        AppActivation.shared.showWindow(controller: self)
        AppActivation.shared.makeKeyAndOrderFront(window: window)
        AppActivation.shared.activate()
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow else { return }
        closing.contentViewController = nil
        if closing === self.window {
            self.model = nil
            self.window = nil
        }
    }
}

private struct MacOpenClawIDJoinView: View {
    @Bindable var model: OnboardingOpenClawIDModel
    let onConnected: () -> Void

    var body: some View {
        OnboardingOpenClawIDView(model: self.model)
            .onChange(of: self.model.step) { _, step in
                if case .connected = step { self.onConnected() }
            }
    }
}
