import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct GatewayChannelRequestTests {
    private func makeSession(requestSendDelayMs: Int) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, _, sendIndex in
                        guard sendIndex == 1 else { return }
                        try await Task.sleep(nanoseconds: UInt64(requestSendDelayMs) * 1_000_000)
                        throw URLError(.cannotConnectToHost)
                    })
            })
    }

    @Test func requestTimeoutThenSendFailureDoesNotDoubleResume() async throws {
        let session = self.makeSession(requestSendDelayMs: 100)
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            _ = try await channel.request(method: "test", params: nil, timeoutMs: 10)
            Issue.record("Expected request to time out")
        } catch {
            let ns = error as NSError
            #expect(ns.domain == "Gateway")
            #expect(ns.code == 5)
        }

        // Give the delayed send failure task time to run; this used to crash due to a double-resume.
        try? await Task.sleep(nanoseconds: 250 * 1_000_000)
    }
}
