import AppKit
import Observation
import SwiftUI

/// Lightweight, borderless panel that shows the current voice wake transcript near the menu bar.
@MainActor
@Observable
final class VoiceWakeOverlayController {
    static var shared: VoiceWakeOverlayController {
        AppStateStore.shared.voiceRuntime.overlay
    }

    enum DismissalCompletion: Sendable {
        case disabledUI
        case missingWindow
        case animated(finishWindow: AppVoiceRuntime.UIAction)
    }

    struct Presentation: Sendable {
        let present: @MainActor @Sendable (VoiceWakeOverlayController, Bool) -> Void
        let updateFrame: @MainActor @Sendable (VoiceWakeOverlayController, Bool) -> Void
        let bringToFront: @MainActor @Sendable (VoiceWakeOverlayController) -> Void
        let animateDismiss: @MainActor @Sendable (
            VoiceWakeOverlayController, DismissReason, SendOutcome,
            @escaping @MainActor @Sendable (DismissalCompletion) -> Void) -> Void

        static let live = Self(
            present: { $0.presentWindow(isFirst: $1) },
            updateFrame: { $0.updateNativeWindowFrame(animate: $1) },
            bringToFront: { $0.bringNativeWindowToFront() },
            animateDismiss: { $0.animateWindowDismissal(reason: $1, outcome: $2, completion: $3) })
    }

    struct Actions: Sendable {
        let send: @MainActor @Sendable (UUID, String) -> Void
        let didPresent: AppVoiceRuntime.UIAction
        let didDismiss: @MainActor @Sendable (UUID, SendOutcome) -> Void
    }

    typealias ActionsProvider = @MainActor @Sendable () -> Actions?
    let presentation: Presentation
    let actions: ActionsProvider

    static func liveActions() -> Actions? {
        Actions(
            send: { VoiceSessionCoordinator.shared.sendNow(token: $0, reason: $1) },
            didPresent: { AppStateStore.shared.startVoiceEars() },
            didDismiss: { token, outcome in
                if outcome == .empty { AppStateStore.shared.blinkOnce() }
                if outcome == .sent { AppStateStore.shared.celebrateSend() }
                AppStateStore.shared.stopVoiceEars()
                VoiceSessionCoordinator.shared.overlayDidDismiss(token: token)
            })
    }

    let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.overlay")
    let enableUI: Bool

    /// Keep the voice wake overlay above any other OpenClaw windows, but below the system’s pop-up menus.
    /// (Menu bar menus typically live at `.popUpMenu`.)
    static let preferredWindowLevel = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue - 4)

    enum Source: String { case wakeWord, pushToTalk }

    var model = Model()
    var isVisible: Bool {
        self.model.isVisible
    }

    struct Model {
        var text: String = ""
        var isFinal: Bool = false
        var isVisible: Bool = false
        var forwardEnabled: Bool = false
        var isSending: Bool = false
        var attributed: NSAttributedString = .init(string: "")
        var isOverflowing: Bool = false
        var isEditing: Bool = false
        var level: Double = 0 // normalized 0...1 speech level for UI
    }

    var window: NSPanel?
    var hostingView: NSHostingView<VoiceWakeOverlayView>?
    var autoSendTask: Task<Void, Never>?
    var autoSendToken: UUID?
    var activeToken: UUID?
    var activeSource: Source?
    var lastLevelUpdate: TimeInterval = 0

    let width: CGFloat = 360
    let padding: CGFloat = 10
    let buttonWidth: CGFloat = 36
    let spacing: CGFloat = 8
    let verticalPadding: CGFloat = 8
    let maxHeight: CGFloat = 400
    let minHeight: CGFloat = 48
    let closeOverflow: CGFloat = 10
    let levelUpdateInterval: TimeInterval = 1.0 / 12.0

    enum DismissReason: Sendable { case explicit, empty }
    enum SendOutcome: Sendable { case sent, empty }
    enum GuardOutcome { case accept, dropMismatch, dropNoActive }

    init(
        enableUI: Bool = true,
        presentation: Presentation = .live,
        actions: @escaping ActionsProvider = VoiceWakeOverlayController.liveActions)
    {
        self.enableUI = enableUI
        self.presentation = presentation
        self.actions = actions
    }
}
