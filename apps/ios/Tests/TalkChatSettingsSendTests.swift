import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

private actor TalkChatSendRecorder {
    private(set) var params: [String: Any]?

    func record(_ value: [String: Any]) {
        self.params = value
    }
}

@MainActor
struct TalkChatSettingsSendTests {
    /// Drives a real native split Talk turn (transcript to `chat.send`) against a fixture Gateway
    /// and checks the marker is sent only when the Gateway advertises `talk-chat-settings`.
    @Test(.testWaitLimit, arguments: [true, false])
    func `native split Talk sends useTalkSettings only when advertised`(advertised: Bool) async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let gateway = GatewayNodeSession()
        let recorder = TalkChatSendRecorder()
        let turnOutcomes = AsyncStream<String>.makeStream()
        defer { talkMode.stop() }
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data = switch message {
            case let .data(value): value
            case let .string(value): Data(value.utf8)
            @unknown default: Data()
            }
            let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            guard let method = frame["method"] as? String, method != "connect" else { return }
            let params = frame["params"] as? [String: Any] ?? [:]
            var payload: [String: Any] = [:]
            switch method {
            case "talk.config":
                let provider: [String: Any] = ["model": "speech-model"]
                payload = ["config": ["talk": [
                    "provider": "xiaomi",
                    "providers": ["xiaomi": provider],
                    "resolved": ["provider": "xiaomi", "config": provider],
                ]]]
            case "chat.send":
                await recorder.record(params)
                let runId = try #require(params["idempotencyKey"] as? String)
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                    "type": "event", "event": "chat",
                    "payload": ["runId": runId, "state": "final", "message": "Reply"],
                ])))
                payload = ["runId": runId, "status": "started"]
            case "talk.speak", "chat.history":
                // The request under test is already recorded; stop before real speech output.
                turnOutcomes.continuation.yield(method)
                await MainActor.run { talkMode.stop() }
            default:
                break
            }
            try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                "type": "res", "id": #require(frame["id"] as? String), "ok": true, "payload": payload,
            ])))
        }, receiveHook: { socket, index in
            if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
            var capabilities = [GatewayServerCapability.chatSendRoutingContract.rawValue]
            if advertised { capabilities.append(GatewayServerCapability.talkChatSettings.rawValue) }
            return .data(GatewayWebSocketTestSupport.connectOkData(
                id: socket.snapshotConnectRequestID() ?? "connect",
                capabilities: capabilities))
        })
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        try await gateway.connect(
            url: #require(URL(string: "ws://talk-settings-test.invalid")),
            credentials: .init(),
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
            onConnected: {},
            onDisconnected: { _ in turnOutcomes.continuation.yield("gateway disconnected") },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
        talkMode.attachGateway(gateway)
        talkMode.updateMainSessionKey("agent:main:talk-settings-test")
        talkMode.updateGatewayConnected(true)
        let capture = try await talkMode.beginPushToTalk()
        await talkMode._test_handlePushToTalkTranscript(
            "What is the time?", isFinal: false, captureId: capture.captureId)
        #expect(talkMode.endPushToTalk(captureId: capture.captureId).status == "queued")

        var outcomes = turnOutcomes.stream.makeAsyncIterator()
        _ = await outcomes.next()
        await gateway.disconnect()

        let sent = try #require(await recorder.params)
        let line = try String(
            data: JSONSerialization.data(withJSONObject: sent, options: [.sortedKeys]),
            encoding: .utf8) ?? ""
        print("TALKPROOF advertised=\(advertised) chat.send params=\(line)")
        #expect((sent["useTalkSettings"] as? Bool) == (advertised ? true : nil))
        #expect(sent["thinking"] == nil)
        #expect(sent["message"] as? String == "What is the time?")
    }
}
