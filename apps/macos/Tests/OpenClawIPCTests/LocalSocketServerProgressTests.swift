import Foundation
import OSLog
import Testing
@testable import OpenClaw

struct LocalSocketServerProgressTests {
    @Test func `idle listeners leave cooperative tasks runnable`() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("socket-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let servers = (0..<ProcessInfo.processInfo.activeProcessorCount).map { index in
            LocalSocketServer(
                socketPath: root.appendingPathComponent("\(index).sock").path,
                logger: Logger(subsystem: "ai.openclaw.tests", category: "LocalSocketServerProgress"))
        }
        // A cooperative timeout cannot run if idle listeners exhaust the executor.
        let releaseWatchdog = DispatchSemaphore(value: 0)
        let watchdogFinished = AsyncStream<Void>.makeStream()
        Thread.detachNewThread {
            if releaseWatchdog.wait(timeout: .now() + 5) == .timedOut {
                for server in servers {
                    server.stop()
                }
            }
            watchdogFinished.continuation.finish()
        }
        do {
            for server in servers {
                try #require(await server.start(handler: { _ in }, onUnexpectedStop: {}))
            }
            await Task.detached {}.value
            let allListening = servers.allSatisfy(\.isListening)
            try #require(allListening, "Idle listeners blocked progress until safety shutdown")
        } catch {
            for server in servers {
                await server.stop().value
            }
            releaseWatchdog.signal()
            for await _ in watchdogFinished.stream {}
            throw error
        }
        for server in servers {
            await server.stop().value
        }
        releaseWatchdog.signal()
        for await _ in watchdogFinished.stream {}
    }
}
