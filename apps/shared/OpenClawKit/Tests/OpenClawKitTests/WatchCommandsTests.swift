import Foundation
@testable import OpenClawKit
import Testing

struct WatchCommandsTests {
    @Test func `app snapshot dual writes semantic and legacy status fields`() throws {
        let message = OpenClawWatchAppSnapshotMessage(
            gatewayStatus: OpenClawWatchAppStatus(code: .gatewayConnected),
            gatewayStatusText: "Connected",
            gatewayConnected: true,
            agentName: "Main",
            sessionKey: "main",
            talkStatus: OpenClawWatchAppStatus(code: .talkOff),
            talkStatusText: "Off",
            talkEnabled: false,
            talkListening: false,
            talkSpeaking: false,
            pendingApprovalCount: 0,
            chatStatus: OpenClawWatchAppStatus(code: .chatNoMessages),
            chatStatusText: "No chat messages yet")

        let encoded = try JSONEncoder().encode(message)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        #expect(object["gatewayStatus"] != nil)
        #expect(object["gatewayStatusText"] as? String == "Connected")
        #expect(object["talkStatus"] != nil)
        #expect(object["talkStatusText"] as? String == "Off")
        #expect(object["chatStatus"] != nil)
        #expect(object["chatStatusText"] as? String == "No chat messages yet")
    }
}
