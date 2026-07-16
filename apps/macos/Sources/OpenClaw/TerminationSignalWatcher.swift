import AppKit
import Foundation
import OSLog

enum AppTerminationTiming {
    static let cleanupDeadlineSeconds = 2.0
    static let signalExitFailsafeSeconds = 3.0
}

@MainActor
final class TerminationSignalWatcher {
    static let shared = TerminationSignalWatcher()

    private static let exitFailsafeQueue = DispatchQueue(
        label: "ai.openclaw.signal-exit-failsafe",
        qos: .userInitiated)

    private let logger = Logger(subsystem: "ai.openclaw", category: "lifecycle")
    private var sources: [DispatchSourceSignal] = []
    private var terminationRequested = false

    func start() {
        guard self.sources.isEmpty else { return }
        self.install(SIGTERM)
        self.install(SIGINT)
    }

    func stop() {
        for s in self.sources {
            s.cancel()
        }
        self.sources.removeAll(keepingCapacity: false)
        self.terminationRequested = false
    }

    private func install(_ sig: Int32) {
        // Make sure the default action doesn't kill the process before we can gracefully shut down.
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { [weak self] in
            self?.handle(sig)
        }
        source.resume()
        self.sources.append(source)
    }

    private func handle(_ sig: Int32) {
        guard !self.terminationRequested else { return }
        self.terminationRequested = true

        self.logger.info("received signal \(sig, privacy: .public); terminating")
        // Ensure any pairing prompt can't accidentally approve during shutdown.
        NodePairingApprovalPrompter.shared.stop()
        DevicePairingApprovalPrompter.shared.stop()
        Self.requestTermination()
    }

    @MainActor
    static func requestTermination(
        armFailsafe: () -> Void = { TerminationSignalWatcher.armExitFailsafe() },
        terminateApplication: () -> Void = { NSApp.terminate(nil) })
    {
        // AppKit may synchronously wait for a terminate-later reply. Arm the safety net
        // before entering that wait so stalled cleanup cannot prevent a bounded exit.
        armFailsafe()
        terminateApplication()
    }

    static func armExitFailsafe(
        after seconds: TimeInterval = AppTerminationTiming.signalExitFailsafeSeconds,
        exitProcess: @escaping @Sendable () -> Void = { exit(0) })
    {
        // NSApp.terminate can block the main dispatch queue while awaiting a
        // terminate-later reply, so this deadline must remain queue-independent.
        self.exitFailsafeQueue.asyncAfter(
            deadline: .now() + seconds,
            execute: exitProcess)
    }
}
