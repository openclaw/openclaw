import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

struct GatewayConnectionAttachmentLimitsTests {
    @Test
    func `attachment policy reads the current hello without resolving the endpoint`() async throws {
        let endpointReads = LockIsolated(0)
        let selectedRevision = LockIsolated(UInt64(1))
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let data = GatewayWebSocketTestSupport.connectOkData(id: socket.snapshotConnectRequestID() ?? "connect")
                var frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var policy = try #require(payload["policy"] as? [String: Any])
                policy["attachments"] = ["maxBytes": 2000, "maxImageBytes": 1000]
                payload["policy"] = policy
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        let url = try #require(URL(string: "ws://attachment-policy.invalid"))
        let connection = GatewayConnection(
            testEndpointProvider: {
                endpointReads.withValue { $0 += 1 }
                return .init(config: (url, nil, nil), routeAuthority: nil, revision: 1)
            },
            currentEndpointRevision: { selectedRevision.value },
            sessionBox: WebSocketSessionBox(session: session))
        let transport = MacGatewayChatTransport(connection: connection)
        #expect(await transport.attachmentLimits() == nil)
        #expect(endpointReads.value == 0)
        #expect(session.snapshotMakeCount() == 0)

        _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
        let readsAfterConnect = endpointReads.value
        #expect(await transport.attachmentLimits() == GatewayAttachmentLimits(maxBytes: 2000, maxImageBytes: 1000))

        // Selection invalidates the old hello before connection teardown runs.
        selectedRevision.withValue { $0 = 2 }
        #expect(await transport.attachmentLimits() == nil)
        await connection.shutdown()
        #expect(await transport.attachmentLimits() == nil)
        #expect(endpointReads.value == readsAfterConnect)
        #expect(session.snapshotMakeCount() == 1)
    }
}
