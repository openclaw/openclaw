import Darwin
import Foundation
import OSLog
import Testing
@testable import OpenClaw

struct LocalSocketServerTests {
    @Test(arguments: [EINTR, ECONNABORTED, EMFILE, ENFILE, ENOMEM, EAGAIN])
    func transientAcceptErrorsRetry(error: Int32) async throws {
        let observations = try await Self.runAcceptScript(firstError: error)
        #expect(observations.calls == 2)
        #expect(observations.backoffs == ([EMFILE, ENFILE, ENOMEM, EAGAIN].contains(error) ? 1 : 0))
    }

    @Test
    func fatalAcceptErrorStopsListener() async throws {
        let observations = try await Self.runAcceptScript(firstError: EBADF)
        #expect(observations.calls == 1)
        #expect(observations.backoffs == 0)
    }

    private static func runAcceptScript(firstError: Int32) async throws -> (calls: Int, backoffs: Int) {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let script = AcceptScript(firstError: firstError)
        let stopped = AsyncTestGate()
        let server = LocalSocketServer(
            socketPath: root.appendingPathComponent("listener.sock").path,
            logger: Logger(subsystem: "ai.openclaw.tests", category: "LocalSocketServer"),
            acceptClient: { fd in script.accept(fd) },
            resourceBackoff: { script.recordBackoff() })
        let started = await server.start(handler: { _ in }, onUnexpectedStop: { stopped.open() })
        if started {
            await stopped.wait()
        }
        await server.stop().value
        try #require(started)
        #expect(!server.isListening)
        return script.observations
    }
}

private final class AcceptScript: @unchecked Sendable {
    private let lock = NSLock()
    private let firstError: Int32
    private var calls = 0
    private var backoffs = 0

    init(firstError: Int32) {
        self.firstError = firstError
    }

    func accept(_: Int32) -> (client: Int32, error: Int32) {
        self.lock.withLock {
            self.calls += 1
            // A terminal error after the injected error makes both the original
            // and repaired loops finish without timers or a blocking accept.
            return (-1, self.calls == 1 ? self.firstError : EBADF)
        }
    }

    func recordBackoff() {
        self.lock.withLock { self.backoffs += 1 }
    }

    var observations: (calls: Int, backoffs: Int) {
        self.lock.withLock { (self.calls, self.backoffs) }
    }
}
