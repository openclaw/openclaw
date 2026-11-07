import Foundation
import OpenClawKit
import XCTest
@testable import OpenClaw

@MainActor
final class TalkTranscriptCompletionTests: XCTestCase {
    func testMatchingFinalBeforeSendAcknowledgementIsReadBack() async throws {
        try await self.checkTranscriptCompletion(.finalBeforeAcknowledgement)
    }

    func testStoppingTalkReleasesAnUnfinishedTranscriptWithoutSpeaking() async throws {
        try await self.checkTranscriptCompletion(.stop)
    }

    func testDisconnectingReleasesAnUnfinishedTranscriptWithoutSpeaking() async throws {
        try await self.checkTranscriptCompletion(.disconnect)
    }

    func testCompletedProgressIsReadBeforeFinalExactlyOnce() async throws {
        try await self.checkTranscriptCompletion(.progress)
    }

    func testStoppingDuringProgressDiscardsQueuedSpeech() async throws {
        try await self.checkTranscriptCompletion(.progressStop)
    }

    func testDisconnectingDuringProgressDiscardsQueuedSpeech() async throws {
        try await self.checkTranscriptCompletion(.progressDisconnect)
    }

    func testInterruptedProgressDoesNotResumeHistoryReadbackOrSpeech() async throws {
        try await self.checkTranscriptCompletion(.progressInterrupt)
    }

    func testLocalProgressHonorsOneShotDirectiveWithoutChangingTheFinalVoice() async throws {
        try await self.checkTranscriptCompletion(.progress, localDirectiveOnce: true)
    }

    func testLocalProgressPersistsVoiceAndModelButNotMessageSpecificSettings() async throws {
        try await self.checkTranscriptCompletion(.progress, localDirectiveOnce: false)
    }

    private enum Outcome: Sendable {
        case finalBeforeAcknowledgement
        case stop
        case disconnect
        case progress
        case progressStop
        case progressDisconnect
        case progressInterrupt

        var hasProgress: Bool {
            self == .progress || self == .progressStop || self == .progressDisconnect || self == .progressInterrupt
        }
    }

    private func checkTranscriptCompletion(_ outcome: Outcome, localDirectiveOnce: Bool? = nil) async throws {
        let usesLocalSpeech = localDirectiveOnce != nil
        if usesLocalSpeech {
            XCTAssertTrue(URLProtocol.registerClass(TranscriptSpeechURLProtocol.self))
            _ = TranscriptSpeechURLProtocol.drain()
        }
        defer {
            if usesLocalSpeech {
                URLProtocol.unregisterClass(TranscriptSpeechURLProtocol.self)
                _ = TranscriptSpeechURLProtocol.drain()
            }
        }
        let submitted = XCTestExpectation(description: "transcript reached chat.send")
        let released = XCTestExpectation(description: "PTT finalizer released audio ownership")
        let requests = TranscriptRequestCapture()
        let synthesizer = TranscriptSpeechSynthesizer()
        let progressRequested = XCTestExpectation(description: "completed progress reaches speech before final")
        if outcome.hasProgress, !usesLocalSpeech {
            synthesizer.onProgress = { progressRequested.fulfill() }
        }
        let localPlayer = TranscriptStreamingPlayer()
        if usesLocalSpeech {
            localPlayer.onProgress = { progressRequested.fulfill() }
        }
        let player = TranscriptAudioPlayer()
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = player
        manager.mp3Player = localPlayer
        manager.setPushToTalkAudioOwnershipEndHandler { _ in released.fulfill() }
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data = switch message {
            case let .data(value): value
            case let .string(value): Data(value.utf8)
            @unknown default: Data()
            }
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let id = try XCTUnwrap(frame["id"] as? String)
            let payload: [String: Any]
            switch frame["method"] as? String {
            case "talk.config" where usesLocalSpeech:
                payload = ["config": ["talk": [
                    "provider": "elevenlabs",
                    "resolved": ["provider": "elevenlabs", "config": [
                        "apiKey": "synthetic-talk-directive-test-key",
                        "voiceId": "syntheticVoiceDefault",
                        "modelId": "eleven_v3",
                        "outputFormat": "mp3_44100_128",
                    ]],
                    "interruptOnSpeech": false,
                ]]]
            case "talk.config":
                payload = ["config": ["talk": [
                    "provider": "xiaomi",
                    "resolved": ["provider": "xiaomi", "config": ["model": "synthetic-speech-model"]],
                    "interruptOnSpeech": false,
                ]]]
            case "chat.history":
                await requests.append(data)
                // A regression must fail at the unexpected history request, without
                // allowing a headless fixture to start the real system synthesizer.
                await manager.stop()
                payload = ["messages": []]
            case "chat.send":
                await requests.append(data)
                let params = try XCTUnwrap(frame["params"] as? [String: Any])
                let runID = try XCTUnwrap(params["idempotencyKey"] as? String)
                if outcome == .finalBeforeAcknowledgement {
                    // The subscription must precede send; neither a foreign terminal
                    // nor a matching terminal arriving before the ACK may lose the reply.
                    try socket.emitReceiveSuccess(.data(Self.finalEvent(
                        runID: "foreign-run", text: "Unrelated reply", sequence: 1)))
                    try socket.emitReceiveSuccess(.data(Self.finalEvent(
                        runID: runID, text: "The list is fixed.", sequence: 2)))
                }
                if outcome.hasProgress {
                    let firstProgress: String
                    if let localDirectiveOnce {
                        firstProgress = """
                        {"voice":"syntheticVoiceProgress","model":"eleven_multilingual_v2","lang":"fr","speed":1.1,"once":\(localDirectiveOnce)}
                        Let me check.
                        """
                    } else {
                        firstProgress = "Let me check."
                    }
                    // Only completed, public progress belonging to this run is speech.
                    for (index, item) in [
                        ("foreign-run", "item", "foreign", "end", "Unrelated progress"),
                        (runID, "reasoning", "private", "end", "Private reasoning"),
                        (runID, "tool", "tool", "end", "Tool output"),
                        (runID, "item", "first", "update", "Growing preview"),
                        (runID, "item", "first", "end", firstProgress),
                        (runID, "item", "first", "end", firstProgress),
                        (runID, "item", "silent", "end", "**NO_REPLY**"),
                        (runID, "item", "directive-silent", "end", "{\"once\":true}\n**NO_REPLY**"),
                        (runID, "item", "second", "end", "Still checking."),
                    ].enumerated() {
                        try socket.emitReceiveSuccess(.data(Self.progressEvent(
                            runID: item.0,
                            stream: item.1,
                            itemID: item.2,
                            phase: item.3,
                            text: item.4,
                            sequence: index + 1)))
                    }
                }
                payload = ["runId": runID, "status": "started"]
                let response = try Self.response(id: id, payload: payload)
                socket.emitReceiveSuccess(.data(response))
                submitted.fulfill()
                return
            default:
                return
            }
            try socket.emitReceiveSuccess(.data(Self.response(id: id, payload: payload)))
        })
        let gateway = GatewayNodeSession()
        do {
            _ = try await connectTalkCleanupTestGateway(gateway, socket: socket)
            manager.attachGateway(gateway)
            manager.updateGatewayConnected(true)
            let capture = try await manager.beginPushToTalk()
            await manager._test_handlePushToTalkTranscript(
                "Please fix the list",
                isFinal: false,
                captureId: capture.captureId)
            XCTAssertEqual(manager.endPushToTalk(captureId: capture.captureId).status, "queued")
            let sent = await XCTWaiter.fulfillment(of: [submitted], timeout: 5)
            XCTAssertEqual(sent, .completed)

            if outcome.hasProgress {
                let heard = await XCTWaiter.fulfillment(of: [progressRequested], timeout: 5)
                XCTAssertEqual(heard, .completed)
                if usesLocalSpeech {
                    XCTAssertEqual(localPlayer.payloads, [Data("Let me check.".utf8)])
                } else {
                    XCTAssertEqual(synthesizer.texts, ["Let me check."])
                    XCTAssertTrue(player.payloads.isEmpty, "first synthesis is deliberately still in flight")
                }
            }

            switch outcome {
            case .finalBeforeAcknowledgement:
                break
            case .progress, .progressInterrupt:
                if outcome == .progressInterrupt {
                    // Headset interruption cancels speech, not the agent/transcript generation.
                    manager._test_stopSpeaking(storeInterruption: false)
                }
                let progressRequests = await requests.snapshot()
                let request = try XCTUnwrap(progressRequests.first)
                let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
                let params = try XCTUnwrap(frame["params"] as? [String: Any])
                let runID = try XCTUnwrap(params["idempotencyKey"] as? String)
                try socket.emitReceiveSuccess(.data(Self.finalEvent(
                    runID: runID, text: "The list is fixed.", sequence: 10)))
            case .stop, .progressStop:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.stop()
            case .disconnect, .progressDisconnect:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.updateGatewayConnected(false)
                await gateway.disconnect()
            }
            synthesizer.completeProgress()
            localPlayer.completeProgress()

            let finished = await XCTWaiter.fulfillment(of: [released], timeout: 5)
            XCTAssertEqual(finished, .completed)
            XCTAssertNil(manager._test_finishingPushToTalkCaptureId())
            let sentRequests = await requests.snapshot()
            XCTAssertEqual(sentRequests.count, 1)
            let request = try XCTUnwrap(sentRequests.first)
            let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
            let params = try XCTUnwrap(frame["params"] as? [String: Any])
            XCTAssertEqual(params["sessionKey"] as? String, "main")
            XCTAssertTrue((params["message"] as? String)?.contains("Please fix the list") == true)
            XCTAssertNil(params["timeoutMs"], "Talk must use the Gateway's configured execution budget")
            XCTAssertNil(params["thinking"], "Talk must inherit the session's thinking policy")
            if outcome == .finalBeforeAcknowledgement {
                XCTAssertEqual(synthesizer.texts, ["The list is fixed."])
                XCTAssertEqual(player.payloads, [Data([1, 2, 3])])
            } else if let localDirectiveOnce {
                XCTAssertTrue(synthesizer.texts.isEmpty)
                let captured = TranscriptSpeechURLProtocol.drain()
                let capturedBodies = try captured.map { request in
                    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
                }
                // Synthesis may prefetch the final before the preceding HTTP request.
                // Inspect settings by message; the player below proves audible order.
                let speech = zip(captured, capturedBodies).sorted {
                    ($0.1["text"] as? String ?? "") < ($1.1["text"] as? String ?? "")
                }
                let speechRequests = speech.map(\.0)
                let bodies = speech.map(\.1)
                XCTAssertEqual(bodies.compactMap { $0["text"] as? String }, [
                    "Let me check.", "Still checking.", "The list is fixed.",
                ])
                let remainingVoice = localDirectiveOnce ? "syntheticVoiceDefault" : "syntheticVoiceProgress"
                XCTAssertEqual(speechRequests.compactMap { $0.url?.path }, [
                    "/v1/text-to-speech/syntheticVoiceProgress/stream",
                    "/v1/text-to-speech/\(remainingVoice)/stream",
                    "/v1/text-to-speech/\(remainingVoice)/stream",
                ])
                XCTAssertEqual(bodies.compactMap { $0["model_id"] as? String }, [
                    "eleven_multilingual_v2",
                    localDirectiveOnce ? "eleven_v3" : "eleven_multilingual_v2",
                    localDirectiveOnce ? "eleven_v3" : "eleven_multilingual_v2",
                ])
                XCTAssertEqual(bodies.first?["language_code"] as? String, "fr")
                XCTAssertNil(bodies.last?["language_code"])
                let settings = try XCTUnwrap(bodies.first?["voice_settings"] as? [String: Any])
                XCTAssertEqual(settings["speed"] as? Double, 1.1)
                XCTAssertEqual(localPlayer.payloads, [
                    "Let me check.", "Still checking.", "The list is fixed.",
                ].map { Data($0.utf8) })
            } else if outcome == .progress {
                XCTAssertEqual(synthesizer.texts, ["Let me check.", "Still checking.", "The list is fixed."])
                XCTAssertEqual(player.payloads.count, 3)
            } else if outcome.hasProgress {
                XCTAssertEqual(synthesizer.texts, ["Let me check."])
                XCTAssertTrue(player.payloads.isEmpty)
            } else {
                XCTAssertTrue(synthesizer.texts.isEmpty)
                XCTAssertTrue(player.payloads.isEmpty)
            }
            manager.setPushToTalkAudioOwnershipEndHandler(nil)
            manager.stop()
            await gateway.disconnect()
        } catch {
            synthesizer.completeProgress()
            localPlayer.completeProgress()
            manager.setPushToTalkAudioOwnershipEndHandler(nil)
            manager.stop()
            await gateway.disconnect()
            throw error
        }
    }

    private nonisolated static func response(id: String, payload: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "type": "res", "id": id, "ok": true, "payload": payload,
        ])
    }

    private nonisolated static func finalEvent(runID: String, text: String, sequence: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "type": "event", "event": "chat", "seq": sequence,
            "payload": ["runId": runID, "sessionKey": "main", "state": "final", "message": text],
        ])
    }

    private nonisolated static func progressEvent(
        runID: String, stream: String, itemID: String, phase: String, text: String, sequence: Int) throws -> Data
    {
        try JSONSerialization.data(withJSONObject: [
            "type": "event", "event": "agent", "seq": sequence,
            "payload": [
                "runId": runID, "seq": sequence, "stream": stream,
                "data": ["kind": "preamble", "itemId": itemID, "phase": phase, "progressText": text],
            ],
        ])
    }
}

private actor TranscriptRequestCapture {
    private var requests: [Data] = []

    func append(_ request: Data) {
        self.requests.append(request)
    }

    func snapshot() -> [Data] {
        self.requests
    }
}

@MainActor
private final class TranscriptSpeechSynthesizer: TalkGatewaySpeechSynthesizing {
    private(set) var texts: [String] = []
    var onProgress: (() -> Void)?
    private var progressContinuation: CheckedContinuation<Void, Never>?

    func synthesize(_ request: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        self.texts.append(request.text)
        if request.text == "Let me check.", let onProgress {
            await withCheckedContinuation { continuation in
                self.progressContinuation = continuation
                onProgress()
            }
        }
        return TalkGatewaySpeechAudio(data: Data([1, 2, 3]), provider: "xiaomi", outputFormat: "mp3")
    }

    func completeProgress() {
        self.progressContinuation?.resume()
        self.progressContinuation = nil
    }
}

@MainActor
private final class TranscriptAudioPlayer: TalkBufferedAudioPlaying {
    private(set) var payloads: [Data] = []

    func setLevelHandler(_ handler: (@MainActor (Double?) -> Void)?) {}

    func play(data: Data) async -> StreamingPlaybackResult {
        self.payloads.append(data)
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}

/// Observe the actual ElevenLabs HTTP boundary without a provider call or production injection hook.
private final class TranscriptSpeechURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requests: [URLRequest] = []

    static func drain() -> [URLRequest] {
        self.lock.lock()
        defer { self.lock.unlock() }
        let requests = self.requests
        self.requests = []
        return requests
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "api.elevenlabs.io" &&
            request.value(forHTTPHeaderField: "xi-api-key") == "synthetic-talk-directive-test-key"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            request.httpBody = body
        }
        Self.lock.lock()
        Self.requests.append(request)
        Self.lock.unlock()
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 200,
                  httpVersion: nil,
                  headerFields: ["Content-Type": "audio/mpeg"])
        else {
            self.client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let text = body?["text"] as? String ?? ""
        self.client?.urlProtocol(self, didLoad: Data(text.utf8))
        self.client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
private final class TranscriptStreamingPlayer: StreamingAudioPlaying {
    private(set) var payloads: [Data] = []
    var onProgress: (() -> Void)?
    private var progressContinuation: CheckedContinuation<Void, Never>?

    func play(stream: AsyncThrowingStream<Data, Error>) async -> StreamingPlaybackResult {
        do {
            var data = Data()
            for try await chunk in stream {
                data.append(chunk)
            }
            self.payloads.append(data)
            if self.payloads.count == 1, let onProgress {
                await withCheckedContinuation { continuation in
                    self.progressContinuation = continuation
                    onProgress()
                }
            }
            return StreamingPlaybackResult(finished: true, interruptedAt: nil)
        } catch {
            return StreamingPlaybackResult(finished: false, interruptedAt: nil)
        }
    }

    func completeProgress() {
        self.progressContinuation?.resume()
        self.progressContinuation = nil
    }

    func stop() -> Double? {
        nil
    }
}
