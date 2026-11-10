import Darwin
import Foundation
import OSLog
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
struct LocalSocketServerTests {
    @Test(arguments: [EINTR, ECONNABORTED, EMFILE, ENFILE, ENOMEM, EAGAIN])
    func transientAcceptErrorsRecoverClientRequests(error: Int32) async throws {
        let script = AcceptScript(firstError: error)
        try await Self.withServer(acceptClient: { script.accept($0) }) { server, socketPath in
            try #require(await server.start(handler: { handle in
                do {
                    try configureSocketTimeouts(handle.fileDescriptor, timeoutMs: 1000)
                    let request = try readLineFromSocket(handle.fileDescriptor, maxBytes: 128)
                    #expect(request == "\"ping\"")
                    try handle.write(contentsOf: Data("\"pong\"\n".utf8))
                } catch {
                    Issue.record(error)
                }
            }, onUnexpectedStop: { Issue.record("Listener stopped after a recoverable error") }))
            let response = try await ExecApprovalsSocketTestSupport.roundTrip(
                socketPath: socketPath, message: "ping", response: String.self)
            #expect(response == "pong")
            #expect(server.isListening)
        }
    }

    @Test
    func stopDuringResourceShortageReleasesSocket() async throws {
        let failed = AsyncTestGate()
        try await Self.withServer(acceptClient: { _ in
            // Keep resource pressure active; the listener uses its real backoff until stopped.
            failed.open()
            return (-1, EMFILE)
        }) { server, socketPath in
            try #require(await server.start(handler: { _ in }, onUnexpectedStop: {
                Issue.record("Resource shortage stopped the listener unexpectedly")
            }))
            try await failed.wait("resource shortage")
            await server.stop().value
            #expect(!server.isListening)
            #expect(try ExecApprovalsSocketPathGuard.pathKind(at: socketPath) == .missing)
            let replacement = LocalSocketServer(
                socketPath: socketPath, logger: Logger(subsystem: "ai.openclaw.tests", category: "LocalSocketServer"))
            let restarted = await replacement.start(handler: { _ in }, onUnexpectedStop: {})
            await replacement.stop().value
            #expect(restarted)
        }
    }

    @Test
    func fatalAcceptErrorStopsListener() async throws {
        let stopped = AsyncTestGate()
        try await Self.withServer(acceptClient: { _ in (-1, EBADF) }) { server, socketPath in
            try #require(await server.start(handler: { _ in }, onUnexpectedStop: { stopped.open() }))
            try await stopped.wait("fatal accept error shutdown")
            #expect(!server.isListening)
            #expect(try ExecApprovalsSocketPathGuard.pathKind(at: socketPath) == .missing)
        }
    }

    private static func withServer(
        acceptClient: @escaping @Sendable (Int32) -> (client: Int32, error: Int32),
        operation: (LocalSocketServer, String) async throws -> Void) async throws
    {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let socketPath = root.appendingPathComponent("listener.sock").path
        let server = LocalSocketServer(
            socketPath: socketPath,
            logger: Logger(subsystem: "ai.openclaw.tests", category: "LocalSocketServer"),
            acceptClient: acceptClient)
        do {
            try await operation(server, socketPath)
        } catch {
            await server.stop().value
            throw error
        }
        await server.stop().value
    }
}

private final class AcceptScript: @unchecked Sendable {
    private let lock = NSLock()
    private var firstError: Int32?

    init(firstError: Int32) {
        self.firstError = firstError
    }

    func accept(_ fd: Int32) -> (client: Int32, error: Int32) {
        if let error = self.lock.withLock({
            defer { self.firstError = nil }
            return self.firstError
        }) {
            return (-1, error)
        }
        let client = Darwin.accept(fd, nil, nil)
        return (client, client < 0 ? errno : 0)
    }
}
