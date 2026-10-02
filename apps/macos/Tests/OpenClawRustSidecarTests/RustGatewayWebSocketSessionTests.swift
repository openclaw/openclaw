import Foundation
import Testing
@testable import OpenClawRustSidecar

struct RustGatewayWebSocketSessionTests {
    @Test func `raw websocket metadata rejects non UTF8 objects and trailing JSON`() {
        let object = "{\"id\":\"receipt\"}"
        let invalid = [
            Data("[]".utf8),
            Data("{}{}".utf8),
            Data("{} trailing".utf8),
            Data([0xEF, 0xBB, 0xBF]) + Data(object.utf8),
            Data([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D]),
        ] +
            [String.Encoding.utf16, .utf16LittleEndian, .utf16BigEndian, .utf32, .utf32LittleEndian, .utf32BigEndian]
            .compactMap { object.data(using: $0) }
        for input in invalid {
            #expect(throws: (any Error).self) {
                try RustGatewayWebSocketSession.gatewayFrameMetadata(input)
            }
        }
    }

    @Test func `commandless connect retains identity with an empty manifest`() throws {
        let commandlessConnect = try Self.frame([
            "type": "req",
            "id": "connect-without-commands",
            "method": "connect",
            "params": ["role": "node"],
        ])

        let metadata = try RustGatewayWebSocketSession.gatewayFrameMetadata(commandlessConnect)
        #expect(metadata.id == "connect-without-commands")
        #expect(metadata.commands?.isEmpty == true)
    }

    @Test func `finish retains only terminal connect failures`() throws {
        let connectID = "connect-1"
        let failedConnect = try Self.frame([
            "type": "res",
            "id": connectID,
            "ok": false,
            "error": ["message": "UNAUTHORIZED"],
        ])
        let successfulConnect = try Self.frame([
            "type": "res",
            "id": connectID,
            "ok": true,
        ])
        let invocationEvent = try Self.frame([
            "type": "event",
            "event": "node.invoke.request",
            "params": ["invokeId": "late-native-work"],
        ])
        let ordinaryResponse = try Self.frame([
            "type": "res",
            "id": "ordinary-request",
            "ok": false,
        ])

        #expect(RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            failedConnect, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            successfulConnect, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            invocationEvent, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            ordinaryResponse, connectID: connectID))
        #expect(!RustGatewayWebSocketSession._testRetainsBufferedFrameAfterFinish(
            failedConnect, connectID: nil))
    }

    @Test func `late delivery after finish is rejected`() throws {
        let invocationEvent = try Self.frame([
            "type": "event",
            "event": "node.invoke.request",
            "params": ["invokeId": "retired-native-work"],
        ])

        #expect(RustGatewayWebSocketSession._testRejectsDeliveryAfterFinish(invocationEvent))
    }

    private static func frame(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
