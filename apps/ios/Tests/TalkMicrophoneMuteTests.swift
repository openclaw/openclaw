import Foundation
import OpenClawKit
import Observation
import Testing
import XCTest
@testable import OpenClaw

@MainActor
struct TalkMicrophoneMuteTests {
    enum Fallback: CaseIterable, Sendable {
        case error, timeout, emptyFinal
    }

    enum Toggle: CaseIterable, Sendable {
        case unmute, remute, emptyUnmute
    }

    @Test func `mute finalizes native recognition and survives restart without blocking standalone PTT`() async throws {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.updateGatewayConnected(true)
        manager.gatewayTalkConfigLoaded = true
        manager.isEnabled = true
        defer { manager.stop() }
        await manager.start()
        #expect(manager.isListening)
        #expect(manager._test_hasRecognitionRequest())
        let oldGeneration = manager._test_recognitionGeneration()

        await manager.setMicrophoneMuted(true)
        #expect(manager.isEnabled)
        #expect(!manager.isListening)
        #expect(manager._test_hasRecognitionRequest())
        await manager._test_handleTranscript(
            "", isFinal: true, pttCaptureId: nil, recognitionGeneration: oldGeneration)
        #expect(!manager._test_hasRecognitionRequest())
        await manager._test_handleTranscript(
            "Buffered words after mute",
            isFinal: false,
            pttCaptureId: nil,
            recognitionGeneration: oldGeneration)
        #expect(manager._test_lastTranscript().isEmpty)
        await #expect(throws: Error.self) {
            _ = try await manager.beginPushToTalk()
        }

        manager.stop()
        manager.isEnabled = true
        await manager.start()
        #expect(manager.isMicrophoneMuted)
        #expect(!manager.isListening)
        #expect(!manager._test_hasRecognitionRequest())
        await manager.setMicrophoneMuted(false)
        #expect(manager.isListening)
        #expect(manager._test_hasRecognitionRequest())

        await manager.setMicrophoneMuted(true)
        manager.stop()
        let capture = try await manager.beginPushToTalk(transcriptionOnly: true)
        #expect(manager.isListening)
        #expect(manager._test_hasRecognitionRequest())
        #expect(manager.endPushToTalk(captureId: capture.captureId).status == "empty")
    }

    @Test(arguments: [false, true])
    func `mute submits the completed pre-mute utterance exactly once`(hasPartial: Bool) async throws {
        try await withNativeMuteFixture { fixture in
            let manager = fixture.manager
            let generation = manager._test_recognitionGeneration()
            if hasPartial {
                await manager._test_handleTranscript(
                    "five", isFinal: false, pttCaptureId: nil, recognitionGeneration: generation)
            }
            await manager.setMicrophoneMuted(true)
            #expect(!manager.isListening)
            #expect(await fixture.requests.prompts.isEmpty)

            // Speech can finish pre-mute audio after capture has already stopped.
            await manager._test_handleTranscript(
                "five four", isFinal: true, pttCaptureId: nil, recognitionGeneration: generation)
            await manager._test_handleTranscript(
                "late duplicate", isFinal: true, pttCaptureId: nil, recognitionGeneration: generation)

            #expect(await fixture.requests.prompts == [
                "Talk Mode active. Reply in a concise, spoken tone.\n\nfive four",
            ])
            #expect(manager.isEnabled)
            #expect(manager.isMicrophoneMuted)
            #expect(!manager.isListening)
        }
    }

    @Test(arguments: Fallback.allCases)
    func `mute preserves the latest partial when finalization has no usable result`(fallback: Fallback) async throws {
        try await withNativeMuteFixture { fixture in
            let manager = fixture.manager
            let generation = manager._test_recognitionGeneration()
            await manager._test_handleTranscript(
                "five", isFinal: false, pttCaptureId: nil, recognitionGeneration: generation)
            await manager.setMicrophoneMuted(true)
            await manager._test_handleTranscript(
                "five four", isFinal: false, pttCaptureId: nil, recognitionGeneration: generation)
            #expect(await fixture.requests.prompts.isEmpty)
            switch fallback {
            case .timeout:
                fixture.timeout.yield(())
                let result = await XCTWaiter.fulfillment(of: [fixture.sent], timeout: 5)
                #expect(result == .completed)
            case .error, .emptyFinal:
                await manager._test_handleTranscript(
                    "", isFinal: fallback == .emptyFinal, pttCaptureId: nil, recognitionGeneration: generation,
                    error: fallback == .error ? NSError(domain: "SyntheticSpeech", code: 1) : nil)
            }
            await manager._test_handleTranscript(
                "late final", isFinal: true, pttCaptureId: nil, recognitionGeneration: generation)
            #expect(await fixture.requests.prompts == [
                "Talk Mode active. Reply in a concise, spoken tone.\n\nfive four",
            ])
        }
    }

    @Test(arguments: Toggle.allCases)
    func `quick mute toggles preserve finalization and resume safely`(toggle: Toggle) async throws {
        try await withNativeMuteFixture { fixture in
            let manager = fixture.manager
            let oldGeneration = manager._test_recognitionGeneration()
            if toggle != .emptyUnmute {
                await manager._test_handleTranscript(
                    "five", isFinal: false, pttCaptureId: nil, recognitionGeneration: oldGeneration)
            }
            await manager.setMicrophoneMuted(true)
            await manager.setMicrophoneMuted(false)
            await manager.start()
            #expect(manager._test_recognitionGeneration() == oldGeneration)
            #expect(!manager.isListening)
            if toggle == .remute {
                await manager.setMicrophoneMuted(true)
            }
            await manager._test_handleTranscript(
                toggle == .emptyUnmute ? "" : "five four", isFinal: true,
                pttCaptureId: nil, recognitionGeneration: oldGeneration)
            let expected = toggle == .emptyUnmute ? [] : [
                "Talk Mode active. Reply in a concise, spoken tone.\n\nfive four",
            ]
            #expect(await fixture.requests.prompts == expected)
            if toggle == .remute {
                await manager.setMicrophoneMuted(false)
            }
            if !manager.isListening {
                let resumed = XCTestExpectation(description: "capture resumes after finalization")
                withObservationTracking {
                    _ = manager.isListening
                } onChange: {
                    resumed.fulfill()
                }
                let result = await XCTWaiter.fulfillment(of: [resumed], timeout: 5)
                #expect(result == .completed)
            }
            #expect(manager.isListening)
            let newGeneration = manager._test_recognitionGeneration()
            #expect(newGeneration != oldGeneration)
            await manager._test_handleTranscript(
                "new utterance", isFinal: false, pttCaptureId: nil, recognitionGeneration: newGeneration)
            await manager._test_handleTranscript(
                "old final", isFinal: true, pttCaptureId: nil, recognitionGeneration: oldGeneration,
                error: NSError(domain: "SyntheticSpeech", code: 2))
            #expect(manager._test_lastTranscript() == "new utterance")
            #expect(manager.isListening)
            #expect(await fixture.requests.prompts == expected)
        }
    }

    @Test(arguments: [false, true])
    func `Talk stop or session change discards pending muted recognition`(replacesSession: Bool) async throws {
        try await withNativeMuteFixture { fixture in
            let manager = fixture.manager
            let generation = manager._test_recognitionGeneration()
            await manager._test_handleTranscript(
                "five", isFinal: false, pttCaptureId: nil, recognitionGeneration: generation)
            await manager.setMicrophoneMuted(true)
            if replacesSession {
                manager.updateMainSessionKey("agent:main:replacement")
            } else {
                manager.stop()
            }
            fixture.timeout.yield(())
            await manager._test_handleTranscript(
                "five four", isFinal: true, pttCaptureId: nil, recognitionGeneration: generation)
            #expect(await fixture.requests.prompts.isEmpty)
            #expect(manager._test_lastTranscript().isEmpty)
            #expect(manager.isEnabled == replacesSession)
            #expect(!manager.isListening)
        }
    }

    @Test func `mute during PTT preparation retires the reservation`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.updateGatewayConnected(true)
        manager.gatewayTalkConfigLoaded = true
        manager.isEnabled = true
        manager._test_setPTTReservedHandler { await manager.setMicrophoneMuted(true) }
        defer {
            manager._test_setPTTReservedHandler(nil)
            manager.stop()
        }

        await #expect(throws: Error.self) {
            _ = try await manager.beginPushToTalk()
        }
        #expect(manager.isMicrophoneMuted)
        #expect(manager._test_activePushToTalkCaptureId() == nil)
        #expect(!manager._test_hasRecognitionRequest())
    }

    @Test func `realtime readiness cannot report listening while muted`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.isEnabled = true
        defer { manager.stop() }
        await manager.setMicrophoneMuted(true)
        manager._test_handleRealtimeRelayStatus("Listening (Realtime)")
        #expect(!manager.isListening)
        #expect(manager.isMicrophoneMuted)
        manager._test_handleRealtimeRelayStatus("Speaking")
        #expect(manager.phase == .speaking)
        #expect(!manager.isListening)
    }
}

private actor NativeMuteRequests {
    private(set) var prompts: [String] = []

    func record(_ prompt: String) {
        self.prompts.append(prompt)
    }
}

@MainActor
private struct NativeMuteFixture {
    let manager: TalkModeManager
    let requests: NativeMuteRequests
    let timeout: AsyncStream<Void>.Continuation
    let sent: XCTestExpectation
}

@MainActor
private func withNativeMuteFixture(_ body: (NativeMuteFixture) async throws -> Void) async throws {
    let clock = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let requests = NativeMuteRequests()
    let sent = XCTestExpectation(description: "finalized utterance reaches chat.send")
    let manager = TalkModeManager(allowSimulatorCapture: true, recognitionFinalizationSleep: {
        for await _ in clock.stream { return }
    })
    let gateway = GatewayNodeSession()
    let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
        guard let method = GatewayWebSocketTestSupport.requestMethod(from: message),
              method != "connect",
              let id = GatewayWebSocketTestSupport.requestID(from: message)
        else { return }
        let payload: String
        switch method {
        case "talk.config":
            payload = #"{"config":{}}"#
        case "chat.send":
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: throw URLError(.badServerResponse)
            }
            let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let params = try #require(frame["params"] as? [String: Any])
            let prompt = try #require(params["message"] as? String)
            let runID = try #require(params["idempotencyKey"] as? String)
            await requests.record(prompt)
            sent.fulfill()
            // The contract under test ends at the real send boundary. A supported terminal
            // error acknowledgement avoids waiting for unrelated model and speech playback.
            payload = "{\"runId\":\"\(runID)\",\"status\":\"error\"}"
        default:
            throw URLError(.unsupportedURL)
        }
        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id, payload: payload)))
    })
    do {
        _ = try await connectTalkCleanupTestGateway(gateway, socket: socket)
        manager.attachGateway(gateway)
        manager.updateGatewayConnected(true)
        manager.gatewayTalkConfigLoaded = true
        manager.isEnabled = true
        await manager.start()
        #expect(manager.isListening)
        try await body(NativeMuteFixture(manager: manager, requests: requests, timeout: clock.continuation, sent: sent))
    } catch {
        manager.stop()
        clock.continuation.finish()
        await gateway.disconnect()
        throw error
    }
    manager.stop()
    clock.continuation.finish()
    await gateway.disconnect()
}
