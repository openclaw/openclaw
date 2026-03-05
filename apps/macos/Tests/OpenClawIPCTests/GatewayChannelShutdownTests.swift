import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct GatewayChannelShutdownTests {
    @Test func shutdownPreventsReconnectLoopFromReceiveFailure() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        // Establish a connection so `listen()` is active.
        try await channel.connect()
        #expect(session.snapshotMakeCount() == 1)

        // Simulate a socket receive failure, which would normally schedule a reconnect.
        session.latestTask()?.emitReceiveFailure()

        // Shut down quickly, before backoff reconnect triggers.
        await channel.shutdown()

        // Wait longer than the default reconnect backoff (500ms) to ensure no reconnect happens.
        try? await Task.sleep(nanoseconds: 750 * 1_000_000)

        #expect(session.snapshotMakeCount() == 1)
    }
}
