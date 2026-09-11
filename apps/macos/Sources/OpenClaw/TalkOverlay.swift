import AppKit
import Observation
import OSLog
import SwiftUI

@MainActor
@Observable
final class TalkOverlayController {
    static let overlaySize: CGFloat = 440
    static let orbSize: CGFloat = 96
    static let orbPadding: CGFloat = 12

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.overlay")

    struct Model {
        var isVisible: Bool = false
        var phase: TalkModePhase = .idle
        var isPaused: Bool = false
        var level: Double = 0
    }

    var model = Model()
    private var window: NSPanel?
    private var hostingView: NSHostingView<TalkOverlayView>?
    private let screenInset: CGFloat = 0
    @ObservationIgnored private var transitionID = UUID()
    @ObservationIgnored let state: AppVoiceRuntime.State
    @ObservationIgnored private let presentation: Presentation
    @ObservationIgnored let actions: ActionsProvider

    struct Presentation: Sendable {
        let present: @MainActor @Sendable (TalkOverlayController, Bool) -> Void
        let animateDismiss: @MainActor @Sendable (
            TalkOverlayController, @escaping @MainActor @Sendable (AppVoiceRuntime.UIAction) -> Void) -> Void

        static let live = Self(
            present: { $0.presentWindow(isFirst: $1) },
            animateDismiss: { owner, completion in
                guard let window = owner.window else { return }
                OverlayPanelFactory.animateDismiss(window: window) {
                    completion { window.orderOut(nil) }
                }
            })
    }

    struct Actions: Sendable {
        let togglePaused: AppVoiceRuntime.UIAction
        let stopSpeaking: AppVoiceRuntime.UIAction
        let pauseForDrag: AppVoiceRuntime.UIAction
        let exit: AppVoiceRuntime.UIAction
    }

    typealias ActionsProvider = @MainActor @Sendable () -> Actions?

    static func liveActions() -> Actions? {
        Actions(
            togglePaused: { TalkModeController.shared.togglePaused() },
            stopSpeaking: { TalkModeController.shared.stopSpeaking(reason: .userTap) },
            pauseForDrag: { TalkModeController.shared.setPaused(true) },
            exit: { TalkModeController.shared.exitTalkMode() })
    }

    init(
        state: @escaping AppVoiceRuntime.State = { AppStateStore.shared },
        presentation: Presentation = .live,
        actions: @escaping ActionsProvider = TalkOverlayController.liveActions)
    {
        self.state = state
        self.presentation = presentation
        self.actions = actions
    }

    func present() {
        self.transitionID = UUID()
        let isFirst = !self.model.isVisible
        if isFirst { self.model.isVisible = true }
        self.presentation.present(self, isFirst)
    }

    private func presentWindow(isFirst: Bool) {
        self.ensureWindow()
        self.hostingView?.rootView = TalkOverlayView(controller: self)
        let target = self.targetFrame()
        OverlayPanelFactory.present(
            window: self.window,
            isFirstPresent: isFirst,
            target: target)
        { window in
            window.setFrame(target, display: true)
            window.orderFrontRegardless()
        }
    }

    func dismiss() {
        let dismissalID = UUID()
        self.transitionID = dismissalID
        self.model.isVisible = false
        self.presentation.animateDismiss(self) { [weak self] finishWindow in
            // A later present or dismiss owns the panel, even while this fade is completing.
            guard self?.transitionID == dismissalID else { return }
            finishWindow()
        }
    }

    func updatePhase(_ phase: TalkModePhase) {
        guard self.model.phase != phase else { return }
        self.logger.info("talk overlay phase=\(phase.rawValue, privacy: .public)")
        self.model.phase = phase
    }

    func updatePaused(_ paused: Bool) {
        guard self.model.isPaused != paused else { return }
        self.logger.info("talk overlay paused=\(paused)")
        self.model.isPaused = paused
    }

    func updateLevel(_ level: Double) {
        guard self.model.isVisible else { return }
        self.model.level = max(0, min(1, level))
    }

    // MARK: - Private

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = OverlayPanelFactory.makePanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.overlaySize, height: Self.overlaySize),
            level: NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue - 4),
            hasShadow: false,
            acceptsMouseMovedEvents: true)

        let host = TalkOverlayHostingView(rootView: TalkOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        let screen = self.window?.screen
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screen else { return .zero }
        let size = NSSize(width: Self.overlaySize, height: Self.overlaySize)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width - self.screenInset,
            y: visible.maxY - size.height - self.screenInset)
        return NSRect(origin: origin, size: size)
    }
}

private final class TalkOverlayHostingView: NSHostingView<TalkOverlayView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}
