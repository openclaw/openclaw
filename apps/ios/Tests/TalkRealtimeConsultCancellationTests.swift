import Foundation
import OpenClawKit
@preconcurrency import WebRTC
import XCTest
@testable import OpenClaw

@MainActor
final class TalkRealtimeConsultCancellationTests: XCTestCase {
    func testHistoryFallbackWaitsForTheAcknowledgedRunInsteadOfANewerForeignReply() async throws {
        let completed = XCTestExpectation(description: "consult returned to listening")
        let requests = ConsultRequestCapture()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            await requests.append(data)
            let payload: [String: Any]
            switch frame["method"] as? String {
            case "talk.client.toolCall":
                payload = ["runId": "owned-run", "agentId": "voice", "agentSessionKey": "global"]
            case "agent.wait":
                payload = ["status": "ok"]
            case "chat.history":
                let owned = await requests.count(method: "chat.history") > 1
                payload = [
                    "sessionKey": "global",
                    "messages": [[
                        "role": "assistant",
                        "content": [["type": "text", "text": owned ? "Owned answer" : "Unrelated answer"]],
                        "timestamp": Date().timeIntervalSince1970 * 1000,
                        "stopReason": "stop",
                        "idempotencyKey": "owned-run",
                        "__openclaw": ["runId": owned ? "owned-run" : "foreign-run"],
                    ]],
                ]
            default:
                return
            }
            let response = try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": XCTUnwrap(frame["id"] as? String), "ok": true, "payload": payload,
            ])
            socket.emitReceiveSuccess(.data(response))
        })
        let delegate = ConsultCancellationDelegate()
        delegate.onListening = { completed.fulfill() }
        try await Self.withSubmittedConsult(socket: socket, delegate: delegate) { _ in
            let finished = await XCTWaiter.fulfillment(of: [completed], timeout: 5)
            XCTAssertEqual(finished, .completed)
            let historyReads = await requests.count(method: "chat.history")
            XCTAssertGreaterThanOrEqual(historyReads, 2, "A foreign reply must not complete the consult")
            XCTAssertFalse(delegate.statuses.contains("OpenClaw unavailable"))
        }
    }

    func testStopBeforeAcknowledgementAbortsTheReturnedGlobalTarget() async throws {
        let held = XCTestExpectation(description: "consult request reached Gateway")
        let aborted = XCTestExpectation(description: "late acknowledged consult was aborted")
        let requests = ConsultRequestCapture()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            await requests.append(data)
            if frame["method"] as? String == "talk.client.toolCall" {
                held.fulfill()
            } else if frame["method"] as? String == "chat.abort" {
                aborted.fulfill()
                let id = try XCTUnwrap(frame["id"] as? String)
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }
        })
        let delegate = ConsultCancellationDelegate()
        try await Self.withSubmittedConsult(socket: socket, delegate: delegate) { talk in
            let sent = await XCTWaiter.fulfillment(of: [held], timeout: 5)
            XCTAssertEqual(sent, .completed)
            let capturedID = await requests.requestID(method: "talk.client.toolCall")
            let requestID = try XCTUnwrap(capturedID)

            // Stopping before the response must not abandon the side-effecting request's run.
            talk.stop()
            let ack = try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": requestID, "ok": true,
                "payload": [
                    "runId": "run-1",
                    "idempotencyKey": "run-1",
                    "agentId": "voice",
                    "agentSessionKey": "global",
                ],
            ])
            socket.emitReceiveSuccess(.data(ack))
            let cancelled = await XCTWaiter.fulfillment(of: [aborted], timeout: 5)
            XCTAssertEqual(cancelled, .completed)
            let capturedAbort = await requests.request(method: "chat.abort")
            let abortData = try XCTUnwrap(capturedAbort)
            let abort = try XCTUnwrap(JSONSerialization.jsonObject(with: abortData) as? [String: Any])
            let params = try XCTUnwrap(abort["params"] as? [String: String])
            XCTAssertEqual(params, ["sessionKey": "global", "agentId": "voice", "runId": "run-1"])
            XCTAssertEqual(delegate.finishes, 1)
            XCTAssertFalse(delegate.statuses.contains("Listening"))
        }
    }

    func testVoiceReplacementPreservesTheLateAcknowledgedRun() async throws {
        let held = XCTestExpectation(description: "consult reached Gateway")
        let aborted = XCTestExpectation(description: "replacement must not abort accepted work")
        aborted.isInverted = true
        let requests = ConsultRequestCapture()
        let socket = GatewayTestWebSocketTask(sendHook: { _, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            await requests.append(data)
            if frame["method"] as? String == "talk.client.toolCall" {
                held.fulfill()
            }
            if frame["method"] as? String == "chat.abort" {
                aborted.fulfill()
            }
        })
        let delegate = ConsultCancellationDelegate()
        try await Self.withSubmittedConsult(socket: socket, delegate: delegate) { talk in
            let sent = await XCTWaiter.fulfillment(of: [held], timeout: 5)
            XCTAssertEqual(sent, .completed)
            let capturedID = await requests.requestID(method: "talk.client.toolCall")
            let requestID = try XCTUnwrap(capturedID)
            talk.stop(preserveRuns: true)
            let ack = try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": requestID, "ok": true,
                "payload": ["runId": "run-1", "agentId": "voice", "agentSessionKey": "global"],
            ])
            socket.emitReceiveSuccess(.data(ack))
            let retained = await XCTWaiter.fulfillment(of: [aborted], timeout: 1)
            XCTAssertEqual(retained, .completed)
            XCTAssertEqual(delegate.finishes, 1)
            XCTAssertFalse(delegate.statuses.contains("Listening"))
        }
    }

    func testManagerVoiceEventWaitsForOldCloseAndNeverFallsBackAfterReplacementFailure() async throws {
        for stopDuringClose in [false, true] {
            let closeStarted = XCTestExpectation(description: "old call close reached Gateway")
            let completed = XCTestExpectation(description: "voice change failure was reported")
            let requests = ConsultRequestCapture()
            let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
                let data: Data
                switch message {
                case let .data(value): data = value
                case let .string(value): data = Data(value.utf8)
                @unknown default: return
                }
                let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                await requests.append(data)
                let method = frame["method"] as? String
                let payload: [String: Any]
                if method == "talk.client.create" {
                    let initial = await requests.count(method: "talk.client.create") == 1
                    payload = [
                        "provider": "openai", "transport": initial ? "webrtc" : "unsupported",
                        "voiceSessionId": initial ? "voice-1" : "voice-2", "clientSecret": "synthetic",
                    ]
                } else if method == "talk.client.close",
                          (frame["params"] as? [String: Any])?["voiceSessionId"] as? String == "voice-1"
                {
                    closeStarted.fulfill()
                    return
                } else if method == "talk.voice.complete" {
                    completed.fulfill()
                    payload = ["ok": true]
                } else if method == "talk.client.close" {
                    payload = ["ok": true]
                } else { return }
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                    "type": "res", "id": XCTUnwrap(frame["id"] as? String), "ok": true, "payload": payload,
                ])))
            }, receiveHook: Self.voiceSelectionHello(methods: Self.voiceSelectionMethods))
            let gateway = GatewayNodeSession()
            let manager = TalkModeManager(allowSimulatorCapture: true)
            do {
                try await gateway.connect(
                    url: XCTUnwrap(URL(string: "ws://talk-test.invalid")),
                    credentials: .init(),
                    connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
                    sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
                    onConnected: {},
                    onDisconnected: { _ in },
                    onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                manager.attachGateway(gateway)
                manager.updateGatewayConnected(true)
                manager._test_applyLoadedTalkConfig(TalkModeGatewayConfigParser.parse(
                    config: ["talk": ["realtime": [
                        "mode": "realtime", "provider": "openai", "transport": "webrtc", "brain": "agent-consult",
                    ]]],
                    defaultProvider: "elevenlabs",
                    defaultModelIdFallback: "eleven_v3",
                    defaultRealtimeModelIdFallback: "gpt-realtime-2",
                    defaultSilenceTimeoutMs: 900))
                manager.gatewayTalkPermissionState = .ready
                await manager.prefetchRealtimeSessionIfReady(reason: "synthetic handoff")
                let deadline = Date().addingTimeInterval(5)
                while !manager._test_hasPrefetchedRealtimeSession(), Date() < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                XCTAssertTrue(manager._test_hasPrefetchedRealtimeSession())
                let currentRoute = await gateway.currentRoute()
                try manager._test_prepareLiveRealtimeVoiceSession(
                    gateway: gateway,
                    route: XCTUnwrap(currentRoute),
                    voiceSessionId: "voice-1",
                    prefetchedVoiceSessionId: "voice-1")
                manager._test_prepareEnabledRealtimeSessionForClose()
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                    "type": "event", "event": "talk.voice.change", "payload": [
                        "changeId": "change-1", "voiceSessionId": "voice-1", "sessionKey": "main",
                        "voice": "alloy", "phase": "requested",
                    ],
                ])))
                let closed = await XCTWaiter.fulfillment(of: [closeStarted], timeout: 5)
                XCTAssertEqual(closed, .completed)
                let countBeforeClose = await requests.count(method: "talk.client.create")
                XCTAssertEqual(countBeforeClose, 1)
                if stopDuringClose { manager.stop() }
                let closeID = await requests.requestID(method: "talk.client.close")
                try socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: XCTUnwrap(closeID))))
                let finished = await XCTWaiter.fulfillment(of: [completed], timeout: 5)
                XCTAssertEqual(finished, .completed)
                let creates = await requests.count(method: "talk.client.create")
                XCTAssertEqual(creates, stopDuringClose ? 1 : 2)
                if !stopDuringClose {
                    let created = await requests.request(method: "talk.client.create")
                    let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(created)) as? [String: Any])
                    let params = try XCTUnwrap(frame["params"] as? [String: Any])
                    XCTAssertEqual(params["voiceChangeId"] as? String, "change-1")
                    XCTAssertEqual(params["voice"] as? String, "alloy")
                    XCTAssertEqual(params["capabilities"] as? [String], ["voice-transcript", "voice-selection"])
                    XCTAssertNil(params["voiceSessionId"])
                }
                let completion = await requests.request(method: "talk.voice.complete")
                let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(completion)) as? [String: Any])
                XCTAssertEqual((frame["params"] as? [String: Any])?["outcome"] as? String, "failed")
                let aborts = await requests.count(method: "chat.abort")
                let sends = await requests.count(method: "chat.send")
                XCTAssertEqual(aborts, 0)
                XCTAssertEqual(sends, 0)
                XCTAssertFalse(manager.isListening)
                manager.stop()
                await gateway.disconnect()
            } catch {
                manager.stop()
                await gateway.disconnect()
                throw error
            }
        }
    }

    func testManagerNegotiatesVoiceSelectionForEveryRealtimeCreatePath() async throws {
        for (methods, supportsSelection) in [
            ([], false),
            (["talk.voice.complete"], false),
            (Self.voiceSelectionMethods, true),
        ] {
            for path in ["prefetch", "webrtc", "gateway-relay"] {
                let created = XCTestExpectation(description: "\(path) create reached Gateway")
                let requests = ConsultRequestCapture()
                let manager = TalkModeManager(allowSimulatorCapture: true)
                let createMethod = path == "gateway-relay" ? "talk.session.create" : "talk.client.create"
                let socket = GatewayTestWebSocketTask(sendHook: { [weak manager] socket, message, _ in
                    let data: Data
                    switch message {
                    case let .data(value): data = value
                    case let .string(value): data = Data(value.utf8)
                    @unknown default: return
                    }
                    let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                    await requests.append(data)
                    if frame["method"] as? String == createMethod {
                        // Stop before replying so awaiting start never opens a microphone or provider call.
                        await manager?.stop()
                        let payload: [String: Any] = path == "gateway-relay" ? [
                            "sessionId": "voice-1", "relaySessionId": "voice-1", "provider": "openai",
                            "mode": "realtime", "transport": "gateway-relay", "brain": "agent-consult",
                        ] : [
                            "provider": "openai", "transport": "webrtc", "voiceSessionId": "voice-1",
                            "clientSecret": "synthetic",
                        ]
                        try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                            "type": "res", "id": XCTUnwrap(frame["id"] as? String), "ok": true, "payload": payload,
                        ])))
                        created.fulfill()
                    } else if ["talk.client.close", "talk.session.close"].contains(frame["method"] as? String ?? "") {
                        let id = try XCTUnwrap(frame["id"] as? String)
                        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    }
                }, receiveHook: Self.voiceSelectionHello(methods: methods))
                let gateway = GatewayNodeSession()
                do {
                    try await gateway.connect(
                        url: XCTUnwrap(URL(string: "ws://talk-test.invalid")),
                        credentials: .init(),
                        connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
                        sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
                        onConnected: {},
                        onDisconnected: { _ in },
                        onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
                    manager.attachGateway(gateway)
                    manager.updateGatewayConnected(true)
                    manager._test_applyLoadedTalkConfig(TalkModeGatewayConfigParser.parse(
                        config: ["talk": ["realtime": [
                            "mode": "realtime", "provider": "openai", "brain": "agent-consult",
                            "transport": path == "gateway-relay" ? "gateway-relay" : "webrtc",
                        ]]],
                        defaultProvider: "elevenlabs",
                        defaultModelIdFallback: "eleven_v3",
                        defaultRealtimeModelIdFallback: "gpt-realtime-2",
                        defaultSilenceTimeoutMs: 900))
                    manager.gatewayTalkPermissionState = .ready
                    if path != "prefetch" { manager._test_prepareEnabledRealtimeSessionForClose() }
                    if path == "prefetch" {
                        await manager.prefetchRealtimeSessionIfReady(reason: "synthetic compatibility")
                    } else {
                        await manager.start()
                    }
                    let reachedGateway = await XCTWaiter.fulfillment(of: [created], timeout: 5)
                    XCTAssertEqual(reachedGateway, .completed, path)
                    let captured = await requests.request(method: createMethod)
                    let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(captured)) as? [String: Any])
                    let params = try XCTUnwrap(frame["params"] as? [String: Any])
                    if path == "gateway-relay" {
                        if supportsSelection {
                            XCTAssertEqual(params["capabilities"] as? [String], ["voice-selection"])
                        } else {
                            XCTAssertNil(params["capabilities"], "Released relay schemas reject this field")
                        }
                    } else {
                        XCTAssertEqual(
                            params["capabilities"] as? [String],
                            supportsSelection ? ["voice-transcript", "voice-selection"] : ["voice-transcript"],
                            path)
                    }
                    XCTAssertNil(params["voiceChangeId"])
                    await gateway.disconnect()
                } catch {
                    manager.stop()
                    await gateway.disconnect()
                    throw error
                }
            }
        }
    }

    private static let voiceSelectionMethods = ["talk.voice.get", "talk.voice.set", "talk.voice.complete"]

    private static func voiceSelectionHello(methods: [String]) -> GatewayTestWebSocketTask.ReceiveHook {
        { socket, index in
            if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
            return .data(GatewayWebSocketTestSupport.connectOkData(
                id: socket.snapshotConnectRequestID() ?? "connect", methods: methods))
        }
    }

    private static func withSubmittedConsult(
        socket: GatewayTestWebSocketTask,
        delegate: ConsultCancellationDelegate,
        body: (TalkRealtimeWebRTCSession) async throws -> Void) async throws
    {
        let gateway = GatewayNodeSession()
        let talk = TalkRealtimeWebRTCSession(
            gateway: gateway,
            sessionKey: "main",
            transcriptStore: TalkRealtimeTranscriptStore(),
            delegate: delegate)
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory()
        let peer = try XCTUnwrap(factory.peerConnection(
            with: RTCConfiguration(),
            constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil),
            delegate: nil))
        defer {
            talk.stop()
            peer.close()
        }
        do {
            try await gateway.connect(
                url: XCTUnwrap(URL(string: "ws://talk-test.invalid")),
                credentials: .init(),
                connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let channel = try XCTUnwrap(peer.dataChannel(
                forLabel: "synthetic-consult",
                configuration: RTCDataChannelConfiguration()))
            let event = #"{"type":"response.function_call_arguments.done","call_id":"call-1","#
                + #""name":"openclaw_agent_consult","arguments":"{\"question\":\"Synthetic consult\"}"}"#
            talk.dataChannel(channel, didReceiveMessageWith: RTCDataBuffer(data: Data(event.utf8), isBinary: false))
            try await body(talk)
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }
}

private actor ConsultRequestCapture {
    private var frames: [Data] = []
    func append(_ data: Data) {
        self.frames.append(data)
    }

    func request(method: String) -> Data? {
        self.frames.last { data in
            let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return frame?["method"] as? String == method
        }
    }

    func requestID(method: String) -> String? {
        guard let data = self.request(method: method),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return frame["id"] as? String
    }

    func count(method: String) -> Int {
        self.frames.count { data in
            let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return frame?["method"] as? String == method
        }
    }
}

@MainActor
private final class ConsultCancellationDelegate: TalkRealtimeWebRTCSessionDelegate {
    var finishes = 0
    var statuses: [String] = []
    var onListening: (() -> Void)?
    func realtimeSession(_: TalkRealtimeWebRTCSession, didChangeStatus status: String) {
        self.statuses.append(status)
        if status == "Listening" {
            self.onListening?()
        }
    }

    func realtimeSession(_: TalkRealtimeWebRTCSession, didDetectInputSpeech _: Bool) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didUpdateAudioLevels _: Double?, output _: Double?) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveUserTranscript _: String) {}
    func realtimeSession(_: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript _: String) {}
    func realtimeSession(
        _: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry _: String,
        error _: Error) {}
    func realtimeSessionDidFinish(_: TalkRealtimeWebRTCSession) {
        self.finishes += 1
    }
}
