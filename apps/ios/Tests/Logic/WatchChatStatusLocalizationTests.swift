import Foundation
import OpenClawKit
import Testing

struct WatchChatStatusLocalizationTests {
    @Test func `snapshot parser keeps semantic status presentation`() throws {
        let snapshot = try #require(WatchAppSnapshotMessage.parsePayload(Self.semanticPayload()))

        #expect(snapshot.gatewayStatus.code == .gatewayProblem)
        #expect(snapshot.gatewayStatus.localizationKey == "Gateway update required")
        #expect(snapshot.gatewayStatus.verbatim == nil)
        #expect(snapshot.talkStatus.code == .talkOff)
        #expect(snapshot.chatStatus?.code == .chatConnectIPhone)
    }

    @Test func `legacy snapshot text decodes but is not written again`() throws {
        let legacyJSON = """
        {
          "gatewayStatusText": "Ancien statut",
          "gatewayConnected": false,
          "agentName": "Main",
          "sessionKey": "main",
          "talkStatusText": "Ancien mode vocal",
          "talkEnabled": true,
          "talkListening": false,
          "talkSpeaking": false,
          "pendingApprovalCount": 0,
          "chatStatusText": "Ancien chat"
        }
        """
        let snapshot = try JSONDecoder().decode(
            WatchAppSnapshotMessage.self,
            from: Data(legacyJSON.utf8))

        #expect(snapshot.gatewayStatus.verbatim == "Ancien statut")
        #expect(snapshot.talkStatus.verbatim == "Ancien mode vocal")
        #expect(snapshot.chatStatus?.verbatim == "Ancien chat")

        let encoded = try JSONEncoder().encode(snapshot)
        let object = try #require(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["gatewayStatusText"] == nil)
        #expect(object["talkStatusText"] == nil)
        #expect(object["chatStatusText"] == nil)
        #expect(object["chatStatus"] != nil)
    }

    @Test func `watch locale resolves semantic chat status independently from phone`() throws {
        let snapshot = try #require(WatchAppSnapshotMessage.parsePayload(Self.semanticPayload()))
        let rendered = WatchAppSnapshotMessage.localizedChatStatusText(
            status: snapshot.chatStatus,
            chatCount: 0,
            hasAppSnapshot: true,
            localize: { key in
                key == .connectIPhoneChat
                    ? "Connectez le chat de l'iPhone"
                    : key.rawValue
            })

        #expect(rendered == "Connectez le chat de l'iPhone")
        #expect(rendered != "Connect iPhone chat to read messages")
    }

    @Test func `persisted semantic command status follows current watch locale`() {
        let status = WatchAppCommandStatus(command: .sendChat, code: .sent)
        let english = status.localizedText(localize: Self.english)
        let french = status.localizedText(localize: Self.french)

        #expect(english == "Chat: sent")
        #expect(french == "Discussion : envoyée")
        #expect(status.command == .sendChat)
    }

    @Test func `gateway presentation localizes key and keeps backend override verbatim`() {
        let localized = OpenClawWatchAppStatus(
            code: .gatewayProblem,
            localizationKey: "Gateway update required")
        let backendOverride = OpenClawWatchAppStatus(
            code: .gatewayProblem,
            verbatim: "Gateway says update channel beta")
        let localizedTalkFailure = OpenClawWatchAppStatus(
            code: .talkFailure,
            localizationKey: "Paused")

        #expect(localized.localizedText(
            localizePresentation: { key, _ in
                key == "Gateway update required" ? "Mise à jour requise" : key
            }) == "Mise à jour requise")
        #expect(backendOverride.localizedText() == "Gateway says update channel beta")
        #expect(localizedTalkFailure.localizedText(
            localizePresentation: { key, _ in
                key == "Paused" ? "En pause" : key
            }) == "En pause")
    }

    private static func semanticPayload() -> [String: Any] {
        [
            "type": OpenClawWatchPayloadType.appSnapshot.rawValue,
            "gatewayStatus": [
                "code": OpenClawWatchAppStatusCode.gatewayProblem.rawValue,
                "localizationKey": "Gateway update required",
            ],
            "gatewayConnected": false,
            "agentName": "Main",
            "sessionKey": "main",
            "talkStatus": [
                "code": OpenClawWatchAppStatusCode.talkOff.rawValue,
            ],
            "talkEnabled": false,
            "talkListening": false,
            "talkSpeaking": false,
            "pendingApprovalCount": 0,
            "chatStatus": [
                "code": OpenClawWatchAppStatusCode.chatConnectIPhone.rawValue,
            ],
        ]
    }

    private static func english(_ key: WatchStatusLocalizationKey) -> String {
        switch key {
        case .chat:
            "Chat"
        case .sentFormat:
            "%@: sent"
        default:
            key.rawValue
        }
    }

    private static func french(_ key: WatchStatusLocalizationKey) -> String {
        switch key {
        case .chat:
            "Discussion"
        case .sentFormat:
            "%@ : envoyée"
        default:
            key.rawValue
        }
    }
}
