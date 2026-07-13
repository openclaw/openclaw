import Foundation
import SwabbleKit
import Testing
@testable import OpenClaw

@Suite(.serialized) struct VoiceWakeManagerStateTests {
    @Test @MainActor func `suspend and resume cycle updates state`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.isListening = true
        manager.statusText = "Listening"

        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == true)
        #expect(manager.isListening == false)
        #expect(manager.statusText == "Paused")

        manager.resumeAfterExternalAudioCapture(wasSuspended: true)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test @MainActor func `handle recognition callback restarts on error`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.isListening = true

        manager._test_handleRecognitionCallback(transcript: nil, segments: [], errorText: "boom")
        #expect(manager.statusText.contains("Recognizer error") == true)
        #expect(manager.isListening == false)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }

    @Test @MainActor func `handle recognition callback dispatches command`() async throws {
        let manager = VoiceWakeManager()
        manager.triggerWords = ["openclaw"]
        manager.isEnabled = true

        actor CaptureBox {
            var value: String?
            func set(_ next: String) {
                self.value = next
            }
        }
        let capture = CaptureBox()
        manager.configure { cmd in
            await capture.set(cmd)
        }

        let transcript = "openclaw hello"
        let triggerRange = try #require(transcript.range(of: "openclaw"))
        let helloRange = try #require(transcript.range(of: "hello"))
        let segments = [
            WakeWordSegment(text: "openclaw", start: 0.0, duration: 0.2, range: triggerRange),
            WakeWordSegment(text: "hello", start: 0.8, duration: 0.2, range: helloRange),
        ]

        manager._test_handleRecognitionCallback(transcript: transcript, segments: segments, errorText: nil)
        #expect(manager.lastTriggeredCommand == "hello")
        #expect(manager.statusText == "Triggered")

        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(await capture.value == "hello")
    }
}
