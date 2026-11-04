import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct TalkMicrophoneMuteTests {
    @Test func `mute retires native recognition and survives restart without blocking standalone PTT`() async throws {
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
