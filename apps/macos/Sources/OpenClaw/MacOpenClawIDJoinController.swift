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
            onConnected: { [weak self] claw in
                self?.close()
                MacOpenClawIDJoinCompletion.finishWithChat(claw: claw)
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
    let onConnected: (String) -> Void

    var body: some View {
        OnboardingOpenClawIDView(model: self.model)
            .onChange(of: self.model.step) { _, step in
                if case let .connected(claw) = step { self.onConnected(claw) }
            }
    }
}

/// One owner for what a successful join with chat means, whichever window started it: the claw
/// becomes this Mac's Gateway and first-run setup is complete, so no setup window stays open on a
/// page that would pick a local Gateway. Setup closes before the primary connection changes, so
/// it never reacts to that change; then the claw's dashboard opens.
@MainActor
enum MacOpenClawIDJoinCompletion {
    static func finishWithChat(
        claw: String,
        markOnboardingComplete: () -> Void = { OnboardingController.markComplete() },
        closeOnboarding: () -> Void = { OnboardingController.shared.close() },
        selectPrimary: (String) -> Void = Self.selectPrimary,
        openDashboard: @escaping () -> Void = { AppNavigationActions.openDashboard() })
    {
        markOnboardingComplete()
        closeOnboarding()
        selectPrimary(claw)
        Task {
            await GatewayEndpointStore.shared.refresh()
            openDashboard()
        }
    }

    private static func selectPrimary(_ claw: String) {
        let state = AppStateStore.shared
        state.remoteTransport = .direct
        state.remoteUrl = "wss://\(claw)"
        state.connectionMode = .remote
    }
}
