import Foundation
import Testing
@testable import OpenClawKit

struct BridgeInvokeMetadataTests {
    @Test func `outer invoke metadata survives the native bridge`() throws {
        let raw = #"{"id":"invoke","command":"system.worker.start","nodeId":"node","paramsJSON":"{\"sessionKey\":\"untrusted\"}","sessionKey":"agent:main:owner","timeoutMs":42000,"idempotencyKey":"attempt","type":"invoke"}"#
        let request = try JSONDecoder().decode(BridgeInvokeRequest.self, from: Data(raw.utf8))
        let encoded = try JSONEncoder().encode(request)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(actual["sessionKey"] as? String == "agent:main:owner")
        #expect(actual["timeoutMs"] as? Int == 42000)
        #expect(actual["idempotencyKey"] as? String == "attempt")
    }

    @Test(arguments: [
        ("mcp.tools.call.v1", #"{"elicitationId":"782A8868-F1CE-4B00-9D18-1B9776358A6E"}"#, 720_000),
        ("mcp.tools.call.v1", "{}", 120_000),
        ("mcp.tools.call.v1", #"{"elicitationId":"invalid"}"#, 120_000),
        ("system.run", #"{"elicitationId":"782A8868-F1CE-4B00-9D18-1B9776358A6E"}"#, 120_000),
    ])
    func `an MCP question grant extends only the native wait`(
        command: String,
        paramsJSON: String,
        expectedWallTimeout: Int) async
    {
        let request = BridgeInvokeRequest(id: "invoke", command: command, paramsJSON: paramsJSON, timeoutMs: 120_000)
        let timeout = GatewayNodeSession.invokeWallTimeoutMs(for: request, timeoutMs: request.timeoutMs)
        #expect(timeout == expectedWallTimeout)
        #expect(GatewayNodeSession.invokeWallTimeoutMs(for: request, timeoutMs: 0) == 0)
        let limit = GatewayNodeSession.maxInvokeTimeoutMs
        #expect(GatewayNodeSession.invokeWallTimeoutMs(for: request, timeoutMs: .max) == limit)

        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: request.timeoutMs,
            onInvoke: { nodeRequest in
                #expect(nodeRequest.timeoutMs == 120_000)
                return BridgeInvokeResponse(id: nodeRequest.id, ok: true)
            })
        #expect(response.ok)
    }
}
