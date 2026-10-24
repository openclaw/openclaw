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

    private enum Outcome: Sendable {
        case finalBeforeAcknowledgement
        case stop
        case disconnect
    }

    private func checkTranscriptCompletion(_ outcome: Outcome) async throws {
        let submitted = XCTestExpectation(description: "transcript reached chat.send")
        let released = XCTestExpectation(description: "PTT finalizer released audio ownership")
        let requests = TranscriptRequestCapture()
        let synthesizer = TranscriptSpeechSynthesizer()
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

            switch outcome {
            case .finalBeforeAcknowledgement:
                break
            case .stop:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.stop()
            case .disconnect:
                XCTAssertEqual(manager._test_finishingPushToTalkCaptureId(), capture.captureId)
                manager.updateGatewayConnected(false)
                await gateway.disconnect()
            }

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
            } else {
                XCTAssertTrue(synthesizer.texts.isEmpty)
                XCTAssertTrue(player.payloads.isEmpty)
            }
            manager.setPushToTalkAudioOwnershipEndHandler(nil)
            manager.stop()
            await gateway.disconnect()
        } catch {
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

    func synthesize(_ request: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        self.texts.append(request.text)
        return TalkGatewaySpeechAudio(data: Data([1, 2, 3]), provider: "xiaomi", outputFormat: "mp3")
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
