import AppKit
import Foundation
import Observation

enum AmbientOverlayEscapeMatcher {
    static let escapeKeyCode: UInt16 = 53

    static func shouldHandle(
        keyCode: UInt16,
        modifierFlags: NSEvent.ModifierFlags,
        isRepeat: Bool) -> Bool
    {
        guard keyCode == Self.escapeKeyCode, !isRepeat else { return false }
        let disallowedModifiers: NSEvent.ModifierFlags = [.command, .control, .option, .shift]
        return modifierFlags.intersection(disallowedModifiers).isEmpty
    }
}

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
    private var escapeMonitor: Any?

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
        self.removeEscapeMonitor()
    }

    func applySettings(_ settings: AmbientOverlaySettings) {
        let normalizedSettings = settings.normalized
        self.settings = normalizedSettings
        self.setEnabled(normalizedSettings.isEnabled)
        if normalizedSettings.isEnabled {
            self.showAmbientSurface(intensity: normalizedSettings.intensity)
            self.showAmbient?(normalizedSettings.intensity)
        }
    }

    func setEnabled(_ isEnabled: Bool) {
        self.settings.isEnabled = isEnabled
        if !isEnabled {
            self.dismissInteractive(reason: .disabled)
            self.closeSurfacesSurface()
            self.closeSurfaces?()
            self.displayController = nil
            self.removeEscapeMonitor()
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
        self.installEscapeMonitorIfNeeded()
        self.scheduleTimeout()
    }

    func dismissInteractive(reason _: DismissReason) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.removeEscapeMonitor()
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
        self.displayControllerIfNeeded()?.showAmbient(
            intensity: intensity,
            displayScope: self.settings.displayScope)
    }

    private func showWorkspaceSurface(onDismiss: @escaping () -> Void) {
        self.displayControllerIfNeeded()?.showWorkspace(
            onDismiss: onDismiss,
            displayScope: self.settings.displayScope)
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
        let seconds = AmbientOverlaySettings.normalizedTimeoutSeconds(self.settings.timeoutSeconds)
        let nanoseconds = UInt64(seconds * 1_000_000_000)
        self.timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            self?.dismissInteractive(reason: .timeout)
        }
    }

    private func installEscapeMonitorIfNeeded() {
        guard self.enableUI, !Self.isRunningTests, self.escapeMonitor == nil else { return }
        self.escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard AmbientOverlayEscapeMatcher.shouldHandle(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags,
                isRepeat: event.isARepeat)
            else { return event }

            Task { @MainActor [weak self] in
                guard let self, self.overlayState == .armed else { return }
                self.dismissInteractive(reason: .escape)
            }
            return nil
        }
    }

    private func removeEscapeMonitor() {
        guard let escapeMonitor else { return }
        NSEvent.removeMonitor(escapeMonitor)
        self.escapeMonitor = nil
    }

    func handleEscapeKeyDownForTesting(
        keyCode: UInt16,
        modifierFlags: NSEvent.ModifierFlags,
        isRepeat: Bool) -> Bool
    {
        guard self.overlayState == .armed else { return false }
        guard AmbientOverlayEscapeMatcher.shouldHandle(
            keyCode: keyCode,
            modifierFlags: modifierFlags,
            isRepeat: isRepeat)
        else { return false }

        self.dismissInteractive(reason: .escape)
        return true
    }
}
