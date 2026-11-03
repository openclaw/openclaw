import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct GatewayChildSupervisorSignalTests {
    @Test func `illegal instruction stops automatic restarts and preserves the crash log`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gateway-child-sigill-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try """
        ulimit -c 0
        printf 'fixture illegal instruction\\n' >&2
        kill -ILL $$
        """.write(to: directory.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
        let log = directory.appendingPathComponent("gateway.log")
        let supervisor = GatewayChildSupervisor()
        let (events, continuation) = AsyncStream<GatewayChildSupervisor.Event>.makeStream()
        defer { continuation.finish() }
        var iterator = events.makeAsyncIterator()
        _ = try await supervisor.start(configuration: .init(
            bun: URL(fileURLWithPath: "/bin/sh"),
            packageRoot: directory,
            environment: [:],
            logPath: log.path,
            port: 19487,
            allowUnconfigured: false)) { continuation.yield($0) }
        let event = await iterator.next()
        let isActive = supervisor.isActive
        let pid = supervisor.processIdentifier
        await supervisor.stop()
        guard case let .failed(message) = event else {
            Issue.record("SIGILL must stop immediately, received \(String(describing: event))")
            return
        }
        #expect(message.contains("SIGILL"))
        #expect(message.contains("Node Gateway"))
        #expect(message.contains("fixture illegal instruction"))
        #expect(!isActive)
        #expect(pid == nil)
        #expect(try String(contentsOf: log, encoding: .utf8) == "fixture illegal instruction\n")
    }
}
