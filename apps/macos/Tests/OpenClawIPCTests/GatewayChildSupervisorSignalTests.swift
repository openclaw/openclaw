import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct GatewayChildSupervisorSignalTests {
    @Test func `illegal instruction retries within the crash limit and preserves the crash log`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gateway-child-sigill-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try """
        ulimit -c 0
        printf 'fixture illegal instruction\\n' >&2
        kill -ILL $$
        """.write(to: directory.appendingPathComponent("openclaw.mjs"), atomically: false, encoding: .utf8)
        let log = directory.appendingPathComponent("gateway.log")
        let clock = ManualTestClock()
        let supervisor = GatewayChildSupervisor(clock: clock)
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
        for seconds in [1, 2, 4, 8] {
            guard await iterator.next() == .restarting(delay: .seconds(seconds)) else {
                Issue.record("SIGILL must use bounded crash recovery")
                await supervisor.stop()
                return
            }
            await clock.waitForSleep(until: clock.now + .seconds(seconds))
            clock.advance(by: .seconds(seconds))
            guard case .started = await iterator.next() else {
                Issue.record("expected a replacement Gateway")
                await supervisor.stop()
                return
            }
        }
        let event = await iterator.next()
        let isActive = supervisor.isActive
        let pid = supervisor.processIdentifier
        await supervisor.stop()
        guard case let .failed(message) = event else {
            Issue.record("expected terminal failure after five SIGILL exits")
            return
        }
        #expect(message.contains("five failed starts"))
        #expect(message.contains("fixture illegal instruction"))
        #expect(!isActive)
        #expect(pid == nil)
        #expect(try String(contentsOf: log, encoding: .utf8) == String(
            repeating: "fixture illegal instruction\n",
            count: 5))
    }
}
