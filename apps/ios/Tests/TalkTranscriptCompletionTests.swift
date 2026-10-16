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

    private enum Outcome: Sendable {
        case finalBeforeAcknowledgement
        case stop
        case disconnect
        case progress
        case progressStop
        case progressDisconnect

        var hasProgress: Bool {
            self == .progress || self == .progressStop || self == .progressDisconnect
        }
    }

    private func checkTranscriptCompletion(_ outcome: Outcome) async throws {
        let submitted = XCTestExpectation(description: "transcript reached chat.send")
        let released = XCTestExpectation(description: "PTT finalizer released audio ownership")
        let requests = TranscriptRequestCapture()
        let synthesizer = TranscriptSpeechSynthesizer()
        let progressRequested = XCTestExpectation(description: "completed progress reaches speech before final")
        if outcome.hasProgress {
            synthesizer.onProgress = { progressRequested.fulfill() }
        }
        let player = TranscriptAudioPlayer()
        let manager = TalkModeManager(
            allowSimulatorCapture: true,
            gatewaySpeechSynthesizer: synthesizer)
        manager.bufferedPlayer = player
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
            case "talk.config":
                payload = ["config": ["talk": [
                    "provider": "xiaomi",
                    "resolved": ["provider": "xiaomi", "config": ["model": "synthetic-speech-model"]],
                    "interruptOnSpeech": false,
                ]]]
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
                    // Only completed, public progress belonging to this run is speech.
                    for (index, item) in [
                        ("foreign-run", "item", "foreign", "end", "Unrelated progress"),
                        (runID, "reasoning", "private", "end", "Private reasoning"),
                        (runID, "tool", "tool", "end", "Tool output"),
                        (runID, "item", "first", "update", "Growing preview"),
                        (runID, "item", "first", "end", "Let me check."),
                        (runID, "item", "first", "end", "Let me check."),
                        (runID, "item", "silent", "end", "**NO_REPLY**"),
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
                XCTAssertEqual(synthesizer.texts, ["Let me check."])
                XCTAssertTrue(player.payloads.isEmpty, "first synthesis is deliberately still in flight")
            }

            switch outcome {
            case .finalBeforeAcknowledgement:
                break
            case .progress:
                let progressRequests = await requests.snapshot()
                let request = try XCTUnwrap(progressRequests.first)
                let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
                let params = try XCTUnwrap(frame["params"] as? [String: Any])
                let runID = try XCTUnwrap(params["idempotencyKey"] as? String)
                try socket.emitReceiveSuccess(.data(Self.finalEvent(
                    runID: runID, text: "The list is fixed.", sequence: 9)))
            case .stop, .progressStop:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.stop()
            case .disconnect, .progressDisconnect:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.updateGatewayConnected(false)
                await gateway.disconnect()
            }
            synthesizer.completeProgress()

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

    func play(data: Data) async -> StreamingPlaybackResult {
        self.payloads.append(data)
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }
}
