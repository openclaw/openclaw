import Darwin
import Dispatch
import Foundation

/// Observes one unreaped child until exit or cancellation; it never signals or reaps it.
final class ChildProcessExit: @unchecked Sendable {
    enum Outcome: Sendable, Equatable {
        case exited
        case timedOut
    }

    private let lock = NSLock()
    private let processIdentifier: pid_t
    private let source: DispatchSourceProcess?
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    init(processIdentifier: pid_t, queue: DispatchQueue = .global(qos: .utility)) {
        self.processIdentifier = processIdentifier
        if Self.hasExited(processIdentifier) {
            self.source = nil
            self.finished = true
            return
        }
        let source = DispatchSource.makeProcessSource(
            identifier: processIdentifier,
            eventMask: .exit,
            queue: queue)
        self.source = source
        source.setEventHandler { [weak self] in
            self?.finish()
        }
        source.resume()
        // The child can exit between the initial waitid probe and kqueue
        // registration. Recheck after resume so that race cannot consume
        // the full timeout when no NOTE_EXIT event is delivered.
        if Self.hasExited(processIdentifier) {
            self.finish()
        }
    }

    func wait(timeout: TimeInterval) async -> Outcome {
        await withTaskGroup(of: Outcome.self) { group in
            group.addTask {
                await self.wait()
                return .exited
            }
            group.addTask {
                do {
                    try await Task.sleep(for: .seconds(timeout))
                    return .timedOut
                } catch {
                    return .exited
                }
            }
            defer { group.cancelAll() }
            return await group.next() ?? .exited
        }
    }

    private func wait() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.waitForSignal() }
            group.addTask { await self.pollUntilExit() }
            defer { group.cancelAll() }
            _ = await group.next()
        }
    }

    private func waitForSignal() async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.lock.lock()
                guard !self.finished else {
                    self.lock.unlock()
                    continuation.resume()
                    return
                }
                self.continuation = continuation
                self.lock.unlock()
            }
        } onCancel: {
            self.finish()
        }
    }

    /// Recover missed NOTE_EXIT events without making launchers own a second observer.
    private func pollUntilExit() async {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .milliseconds(50))
            } catch {
                return
            }
            if Self.hasExited(self.processIdentifier) {
                self.finish()
                return
            }
        }
    }

    func hasExited() -> Bool {
        Self.hasExited(self.processIdentifier)
    }

    private func finish() {
        self.lock.lock()
        guard !self.finished else {
            self.lock.unlock()
            return
        }
        self.finished = true
        let continuation = self.continuation
        self.continuation = nil
        self.lock.unlock()
        self.source?.cancel()
        continuation?.resume()
    }

    /// Subprocess owns reaping after its body completes. WNOWAIT keeps that
    /// status available and pins the process-group identity during cleanup.
    static func hasExited(_ processIdentifier: pid_t) -> Bool {
        while true {
            var info = siginfo_t()
            if waitid(P_PID, id_t(processIdentifier), &info, WEXITED | WNOHANG | WNOWAIT) == 0 {
                return info.si_pid != 0 || info.si_signo != 0
            }
            guard errno == EINTR else { return false }
        }
    }
}
