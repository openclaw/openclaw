import Foundation
import Testing
@testable import Clawdis

@Suite struct BridgeSessionTests {
    @Test func initialStateIsIdle() async {
        let session = BridgeSession()
        #expect(await session.state == .idle)
    }

    @Test func requestFailsWhenNotConnected() async {
        let session = BridgeSession()

        do {
            _ = try await session.request(method: "health", paramsJSON: nil, timeoutSeconds: 1)
            Issue.record("Expected request to throw when not connected")
        } catch let error as NSError {
            #expect(error.domain == "Bridge")
            #expect(error.code == 11)
        }
    }

    @Test func sendEventFailsWhenNotConnected() async {
        let session = BridgeSession()

        do {
            try await session.sendEvent(event: "tick", payloadJSON: nil)
            Issue.record("Expected sendEvent to throw when not connected")
        } catch let error as NSError {
            #expect(error.domain == "Bridge")
            #expect(error.code == 10)
        }
    }

    @Test func disconnectFinishesServerEventStreams() async throws {
        let session = BridgeSession()
        let stream = await session.subscribeServerEvents(bufferingNewest: 1)

        let consumer = Task { @Sendable in
            for await _ in stream {}
        }

        await session.disconnect()

        _ = await consumer.result
        #expect(await session.state == .idle)
    }
}
