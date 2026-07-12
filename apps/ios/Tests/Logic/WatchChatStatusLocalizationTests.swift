import Foundation
import OpenClawKit
import Testing

struct WatchChatStatusLocalizationTests {
    @Test func `snapshot parser keeps known status codes`() throws {
        let snapshot = try #require(WatchAppSnapshotMessage.parsePayload(Self.payload(
            chatStatusCode: OpenClawWatchChatStatusCode.connectIPhone.rawValue,
            chatStatusText: "Legacy status")))

        #expect(snapshot.chatStatusCode == .connectIPhone)
        #expect(snapshot.chatStatusText == "Legacy status")
    }

    @Test func `snapshot parser preserves legacy fallback for unknown status codes`() throws {
        let snapshot = try #require(WatchAppSnapshotMessage.parsePayload(Self.payload(
            chatStatusCode: "futureStatus",
            chatStatusText: "Future status from iPhone")))

        #expect(snapshot.chatStatusCode == nil)
        #expect(snapshot.chatStatusText == "Future status from iPhone")
    }

    @Test func `watch renders known status locally before legacy text`() {
        let rendered = WatchAppSnapshotMessage.localizedChatStatusText(
            statusCode: .noMessages,
            legacyText: "English status from iPhone",
            chatCount: 0,
            hasAppSnapshot: true)

        #expect(rendered == String(localized: "No chat messages yet"))
    }

    @Test func `watch renders legacy text when status code is unknown`() throws {
        let snapshot = try #require(WatchAppSnapshotMessage.parsePayload(Self.payload(
            chatStatusCode: "futureStatus",
            chatStatusText: "Future status from iPhone")))
        let rendered = WatchAppSnapshotMessage.localizedChatStatusText(
            statusCode: snapshot.chatStatusCode,
            legacyText: snapshot.chatStatusText,
            chatCount: 0,
            hasAppSnapshot: true)

        #expect(rendered == "Future status from iPhone")
    }

    private static func payload(
        chatStatusCode: String,
        chatStatusText: String) -> [String: Any]
    {
        [
            "type": OpenClawWatchPayloadType.appSnapshot.rawValue,
            "gatewayStatusText": "Connected",
            "gatewayConnected": true,
            "agentName": "Main",
            "sessionKey": "main",
            "talkStatusText": "Off",
            "talkEnabled": false,
            "talkListening": false,
            "talkSpeaking": false,
            "pendingApprovalCount": 0,
            "chatStatusCode": chatStatusCode,
            "chatStatusText": chatStatusText,
        ]
    }
}
