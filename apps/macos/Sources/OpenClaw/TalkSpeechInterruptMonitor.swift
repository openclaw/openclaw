import AppKit
import OSLog

/// Monitors right Option key (keyCode 61) to interrupt Talk Mode speech.
/// Independent of Push-to-Talk — active whenever Talk Mode is enabled.
final class TalkSpeechInterruptMonitor: @unchecked Sendable {
    struct Registration: Sendable {
        let addGlobal: @MainActor @Sendable (NSEvent.EventTypeMask, @escaping (NSEvent) -> Void) -> Any?
        let addLocal: @MainActor @Sendable (NSEvent.EventTypeMask, @escaping (NSEvent) -> NSEvent?) -> Any?
        let remove: @MainActor @Sendable (Any) -> Void

        static let live = Self(
            addGlobal: { NSEvent.addGlobalMonitorForEvents(matching: $0, handler: $1) },
            addLocal: { NSEvent.addLocalMonitorForEvents(matching: $0, handler: $1) },
            remove: { NSEvent.removeMonitor($0) })
    }

    private let registration: Registration
    private let controller: AppVoiceRuntime.Controller

    init(
        registration: Registration = .live,
        controller: @escaping AppVoiceRuntime.Controller = { TalkModeController.shared })
    {
        self.registration = registration
        self.controller = controller
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.interrupt")
    @MainActor private var globalMonitor: Any?
    @MainActor private var localMonitor: Any?

    func setEnabled(_ enabled: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if enabled {
                self.startMonitoring()
            } else {
                self.stopMonitoring()
            }
        }
    }

    @MainActor private func startMonitoring() {
        guard self.globalMonitor == nil, self.localMonitor == nil else { return }
        self.globalMonitor = self.registration.addGlobal(.flagsChanged) { [weak self] event in
            self?.handleFlags(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
        }
        self.localMonitor = self.registration.addLocal(.flagsChanged) { [weak self] event in
            self?.handleFlags(keyCode: event.keyCode, modifierFlags: event.modifierFlags)
            return event
        }
        self.logger.info("talk interrupt monitor started")
    }

    @MainActor private func stopMonitoring() {
        if let globalMonitor {
            self.registration.remove(globalMonitor)
            self.globalMonitor = nil
        }
        if let localMonitor {
            self.registration.remove(localMonitor)
            self.localMonitor = nil
        }
        self.logger.info("talk interrupt monitor stopped")
    }

    private func handleFlags(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) {
        // Right Option key down (keyCode 61).
        guard keyCode == 61, modifierFlags.contains(.option) else { return }
        Task { @MainActor in
            guard let controller = self.controller(), controller.phase == .speaking else { return }
            self.logger.info("right option — interrupting talk mode speech")
            controller.stopSpeaking(reason: .userTap)
        }
    }
}
