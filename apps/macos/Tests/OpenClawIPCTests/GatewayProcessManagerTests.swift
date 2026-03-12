import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor SendAttemptCounter {
    private(set) var value = 0

    func increment() {
        self.value += 1
    }
}

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    @Test func `clears last failure when health succeeds`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        manager.setTestingLastFailureReason("health failed")
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
    }

    @Test func `returns immediately when startup already failed`() async throws {
        let sendAttempts = SendAttemptCounter()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, _, _ in
                        await sendAttempts.increment()
                    })
            })
        let url = try #require(URL(string: "ws://example.invalid"))
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        manager.setTestingStatus(.failed("openclaw CLI not found in PATH; install the CLI."))
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingStatus(.stopped)
        }

        let startedAt = Date()
        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        let elapsed = Date().timeIntervalSince(startedAt)

        #expect(ready == false)
        #expect(elapsed < 0.2)
        #expect(await sendAttempts.value == 0)
    }
}
