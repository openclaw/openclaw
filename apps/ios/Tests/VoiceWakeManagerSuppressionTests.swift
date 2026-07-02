import Foundation
import Testing
@testable import OpenClaw

@Suite("Voice Wake manager suppression")
struct VoiceWakeManagerSuppressionTests {
    @Test
    @MainActor func `clearing Talk suppression restarts after pending start was canceled`() async {
        let manager = VoiceWakeManager()
        manager.isEnabled = true
        manager.statusText = "Paused"

        manager.setSuppressedByTalk(true)
        manager.setSuppressedByTalk(false)

        try? await Task.sleep(nanoseconds: 500_000_000)
        #expect(manager.statusText.contains("Voice Wake") == true)
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `external audio resumes pending Voice Wake restart`() async {
        let manager = VoiceWakeManager()
        manager.isEnabled = true
        manager.resumeAfterExternalAudioCapture(wasSuspended: true)

        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == true)

        manager.resumeAfterExternalAudioCapture(wasSuspended: suspended)

        try? await Task.sleep(nanoseconds: 900_000_000)
        #expect(manager.statusText.contains("Voice Wake") == true)
        #expect(manager.isListening == false)
    }
}
