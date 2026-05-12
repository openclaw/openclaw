import Foundation
import Testing
import OpenClawProtocol
@testable import OpenClawKit

@Suite struct CanvasRealtimeTalkBridgeTests {
    @Test func consultPayloadCarriesSessionKeyAndTranscript() throws {
        let payload = CanvasRealtimeTalkBridge.consultPayload(
            sessionKey: "agent:main:canvas",
            args: ["question": "What changed?"],
            transcript: [
                ["role": "user", "text": "hello"],
                ["role": "assistant", "text": "hi"],
            ])

        let data = try JSONSerialization.data(withJSONObject: payload)
        let decoded = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        #expect(decoded["sessionKey"] as? String == "agent:main:canvas")
        let args = try #require(decoded["args"] as? [String: Any])
        #expect(args["question"] as? String == "What changed?")
        let transcript = try #require(decoded["transcript"] as? [[String: String]])
        #expect(transcript.count == 2)
        #expect(transcript.first?["role"] == "user")
    }

    @Test func startUsesUnifiedTalkSessionMethods() async throws {
        let recorder = RequestRecorder()
        let events = TestEventHub()
        let bridge = CanvasRealtimeTalkBridge(
            request: { method, paramsJSON, _ in
                await recorder.record(method: method, paramsJSON: paramsJSON)
                switch method {
                case "talk.session.create":
                    return try encodeJSON([
                        "sessionId": "relay-1",
                        "provider": "openai",
                        "transport": "gateway-relay",
                        "relaySessionId": "relay-1",
                        "audio": [
                            "inputEncoding": "pcm16",
                            "inputSampleRateHz": 24_000,
                            "outputEncoding": "pcm16",
                            "outputSampleRateHz": 24_000,
                        ],
                    ])
                case "talk.session.close":
                    return try encodeJSON(["ok": true])
                default:
                    return try encodeJSON([:])
                }
            },
            events: {
                await events.subscribe()
            },
            runtime: makeTestRuntime())

        let status = await bridge.start(sessionKey: "agent:main:canvas")
        #expect(status.ok)
        #expect(status.state == "active")

        let createCall = try #require(await recorder.first(method: "talk.session.create"))
        let createPayload = try decodeJSONObject(createCall.paramsJSON)
        #expect(createPayload["sessionKey"] as? String == "agent:main:canvas")
        #expect(createPayload["mode"] as? String == "realtime")
        #expect(createPayload["transport"] as? String == "gateway-relay")
        #expect(createPayload["brain"] as? String == "agent-consult")

        _ = await bridge.stop()

        let closeCall = try #require(await recorder.first(method: "talk.session.close"))
        let closePayload = try decodeJSONObject(closeCall.paramsJSON)
        #expect(closePayload["sessionId"] as? String == "relay-1")
    }

    @Test func toolCallUsesUnifiedGatewayFlow() async throws {
        let recorder = RequestRecorder()
        let events = TestEventHub()
        let bridge = CanvasRealtimeTalkBridge(
            request: { method, paramsJSON, _ in
                await recorder.record(method: method, paramsJSON: paramsJSON)
                switch method {
                case "talk.session.create":
                    return try encodeJSON([
                        "sessionId": "relay-1",
                        "provider": "openai",
                        "transport": "gateway-relay",
                        "relaySessionId": "relay-1",
                        "audio": [
                            "inputEncoding": "pcm16",
                            "inputSampleRateHz": 24_000,
                            "outputEncoding": "pcm16",
                            "outputSampleRateHz": 24_000,
                        ],
                    ])
                case "talk.client.toolCall":
                    return try encodeJSON(["runId": "run-1"])
                case "talk.session.submitToolResult", "talk.session.close":
                    return try encodeJSON(["ok": true])
                default:
                    return try encodeJSON([:])
                }
            },
            events: {
                await events.subscribe()
            },
            runtime: makeTestRuntime())

        let status = await bridge.start(sessionKey: "agent:main:canvas")
        #expect(status.ok)

        try await waitUntil("relay event subscription") {
            await events.subscriberCount() >= 1
        }
        await events.emit(
            name: "talk.event",
            payload: [
                "relaySessionId": "relay-1",
                "type": "toolCall",
                "callId": "call-1",
                "name": "openclaw_agent_consult",
                "args": ["question": "What changed?"],
            ])

        try await waitUntil("tool call requested") {
            await recorder.count(method: "talk.client.toolCall") == 1
        }
        try await waitUntil("chat event subscription") {
            await events.subscriberCount() >= 2
        }

        await events.emit(
            name: "chat",
            payload: [
                "runId": "run-1",
                "state": "final",
                "message": [
                    "content": [
                        [
                            "type": "text",
                            "text": "It changed.",
                        ],
                    ],
                ],
            ])

        try await waitUntil("tool result submitted") {
            await recorder.count(method: "talk.session.submitToolResult") == 1
        }

        let toolCall = try #require(await recorder.first(method: "talk.client.toolCall"))
        let toolPayload = try decodeJSONObject(toolCall.paramsJSON)
        #expect(toolPayload["sessionKey"] as? String == "agent:main:canvas")
        #expect(toolPayload["callId"] as? String == "call-1")
        #expect(toolPayload["relaySessionId"] as? String == "relay-1")

        let submitCall = try #require(await recorder.first(method: "talk.session.submitToolResult"))
        let submitPayload = try decodeJSONObject(submitCall.paramsJSON)
        #expect(submitPayload["sessionId"] as? String == "relay-1")
        #expect(submitPayload["callId"] as? String == "call-1")
        let result = try #require(submitPayload["result"] as? [String: Any])
        #expect(result["result"] as? String == "It changed.")

        _ = await bridge.stop()
    }
}

private actor RequestRecorder {
    struct Call: Sendable {
        let method: String
        let paramsJSON: String?
    }

    private var calls: [Call] = []

    func record(method: String, paramsJSON: String?) {
        self.calls.append(Call(method: method, paramsJSON: paramsJSON))
    }

    func first(method: String) -> Call? {
        self.calls.first { $0.method == method }
    }

    func count(method: String) -> Int {
        self.calls.filter { $0.method == method }.count
    }
}

private actor TestEventHub {
    private var continuations: [AsyncStream<EventFrame>.Continuation] = []

    func subscribe() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in
            Task {
                self.add(continuation)
            }
        }
    }

    private func add(_ continuation: AsyncStream<EventFrame>.Continuation) {
        self.continuations.append(continuation)
    }

    func subscriberCount() -> Int {
        self.continuations.count
    }

    func emit(name: String, payload: [String: Any]) {
        let frame = EventFrame(
            type: "event",
            event: name,
            payload: AnyCodable(payload),
            seq: nil,
            stateversion: nil)
        for continuation in self.continuations {
            continuation.yield(frame)
        }
    }
}

private func makeTestRuntime() -> CanvasRealtimeTalkBridge.Runtime {
    CanvasRealtimeTalkBridge.Runtime(
        requestMicrophonePermission: { true },
        configureAudioSession: {},
        startCapture: { _, _ in
            CanvasRealtimeTalkBridge.CaptureHandle(stop: {})
        },
        startPlayback: { _, _ in
            CanvasRealtimeTalkBridge.PlaybackHandle(stop: {})
        })
}

private func encodeJSON(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value)
}

private func decodeJSONObject(_ json: String?) throws -> [String: Any] {
    let string = try #require(json)
    let data = Data(string.utf8)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}
