import Foundation
import Observation

@MainActor
@Observable
final class AmbientOverlayExperienceController {
    static let shared = AmbientOverlayExperienceController()

    enum DismissReason: Equatable {
        case closeButton
        case escape
        case hotkey
        case timeout
        case disabled
    }

    private let enableUI: Bool
    private var timeoutTask: Task<Void, Never>?
    private var displayController: AmbientOverlayDisplayController?

    var showAmbient: ((Double) -> Void)?
    var showWorkspace: (((@escaping () -> Void)) -> Void)?
    var hideWorkspace: (() -> Void)?
    var closeSurfaces: (() -> Void)?

    private(set) var overlayState: AmbientOverlayState = .idle
    private(set) var settings: AmbientOverlaySettings = .defaults

    var isEnabled: Bool { self.settings.isEnabled }

    init(enableUI: Bool = true) {
        self.enableUI = enableUI
    }

    @MainActor deinit {
        self.timeoutTask?.cancel()
    }

    func applySettings(_ settings: AmbientOverlaySettings) {
        self.settings = settings
        self.setEnabled(settings.isEnabled)
        if settings.isEnabled {
            self.showAmbient?(settings.intensity)
        }
    }

    func setEnabled(_ isEnabled: Bool) {
        self.settings.isEnabled = isEnabled
        if !isEnabled {
            self.dismissInteractive(reason: .disabled)
            self.closeSurfaces?()
            self.displayController = nil
            self.showAmbient = nil
            self.showWorkspace = nil
            self.hideWorkspace = nil
            self.closeSurfaces = nil
            return
        }

        self.showAmbientIfNeeded()
    }

    func toggleArmed() {
        guard self.isEnabled else {
            self.overlayState = .idle
            return
        }

        switch self.overlayState {
        case .idle, .cooldown:
            self.arm()
        case .arming, .armed, .executing:
            self.dismissInteractive(reason: .hotkey)
        }
    }

    func arm() {
        guard self.isEnabled else {
            self.overlayState = .idle
            return
        }

        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.overlayState = .arming
        self.showAmbientIfNeeded()
        self.overlayState = .armed
        self.showWorkspace? { [weak self] in
            self?.dismissInteractive(reason: .closeButton)
        }
        self.scheduleTimeout()
    }

    func dismissInteractive(reason _: DismissReason) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.hideWorkspace?()
        self.overlayState = .idle
    }

    func showAmbientIfNeeded() {
        guard self.enableUI else { return }
        if self.displayController == nil {
            self.installDisplayController()
        }
        self.showAmbient?(self.settings.intensity)
    }

    private func installDisplayController() {
        let displayController = AmbientOverlayDisplayController()
        let existingShowAmbient = self.showAmbient
        let existingShowWorkspace = self.showWorkspace
        let existingHideWorkspace = self.hideWorkspace
        let existingCloseSurfaces = self.closeSurfaces

        self.displayController = displayController
        self.showAmbient = { intensity in
            displayController.showAmbient(intensity: intensity)
            existingShowAmbient?(intensity)
        }
        self.showWorkspace = { onDismiss in
            displayController.showWorkspace(onDismiss: onDismiss)
            existingShowWorkspace?(onDismiss)
        }
        self.hideWorkspace = {
            displayController.hideWorkspace()
            existingHideWorkspace?()
        }
        self.closeSurfaces = {
            displayController.close()
            existingCloseSurfaces?()
        }
    }

    private func scheduleTimeout() {
        let seconds = max(self.settings.timeoutSeconds, 1)
        let nanoseconds = UInt64(seconds * 1_000_000_000)
        self.timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            self?.dismissInteractive(reason: .timeout)
        }
    }
}
