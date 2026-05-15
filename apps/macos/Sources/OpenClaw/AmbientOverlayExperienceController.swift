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
    var hasDisplayControllerForTesting: Bool { self.displayController != nil }

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
            self.showAmbientSurface(intensity: settings.intensity)
            self.showAmbient?(settings.intensity)
        }
    }

    func setEnabled(_ isEnabled: Bool) {
        self.settings.isEnabled = isEnabled
        if !isEnabled {
            self.dismissInteractive(reason: .disabled)
            self.closeSurfacesSurface()
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
        let onDismiss = { [weak self] in
            guard let self else { return }
            self.dismissInteractive(reason: .closeButton)
        }
        self.showWorkspaceSurface(onDismiss: onDismiss)
        self.showWorkspace?(onDismiss)
        self.scheduleTimeout()
    }

    func dismissInteractive(reason _: DismissReason) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.hideWorkspaceSurface()
        self.hideWorkspace?()
        self.overlayState = .idle
    }

    func showAmbientIfNeeded() {
        guard self.enableUI else { return }
        self.showAmbientSurface(intensity: self.settings.intensity)
        self.showAmbient?(self.settings.intensity)
    }

    private func showAmbientSurface(intensity: Double) {
        self.displayControllerIfNeeded()?.showAmbient(intensity: intensity)
    }

    private func showWorkspaceSurface(onDismiss: @escaping () -> Void) {
        self.displayControllerIfNeeded()?.showWorkspace(onDismiss: onDismiss)
    }

    private func hideWorkspaceSurface() {
        self.displayController?.hideWorkspace()
    }

    private func closeSurfacesSurface() {
        self.displayController?.close()
        self.displayController = nil
    }

    private func displayControllerIfNeeded() -> AmbientOverlayDisplayController? {
        guard self.enableUI, !Self.isRunningTests else { return nil }
        if self.displayController == nil {
            self.displayController = AmbientOverlayDisplayController()
        }
        return self.displayController
    }

    private nonisolated static var isRunningTests: Bool {
        let processName = ProcessInfo.processInfo.processName
        let mainBundlePath = Bundle.main.bundleURL.path
        let executableName = Bundle.main.executableURL?.lastPathComponent
        return ProcessInfo.processInfo.isRunningTests
            || processName.hasSuffix("PackageTests")
            || processName.hasSuffix("Tests")
            || processName == "swiftpm-testing-helper"
            || mainBundlePath.contains(".xctest")
            || executableName?.hasSuffix("PackageTests") == true
            || executableName?.hasSuffix("Tests") == true
            || executableName == "swiftpm-testing-helper"
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
