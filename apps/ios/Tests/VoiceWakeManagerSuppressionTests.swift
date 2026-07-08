import Foundation
import Testing
@testable import OpenClaw

@Suite("Voice Wake manager suppression", .serialized)
struct VoiceWakeManagerSuppressionTests {
    @Test
    @MainActor func `clearing Talk suppression restarts after pending start was canceled`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Paused"

        manager.setSuppressedByTalk(true)
        manager.setSuppressedByTalk(false)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `external audio resumes pending Voice Wake restart`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.resumeAfterExternalAudioCapture(wasSuspended: true)

        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == true)

        manager.resumeAfterExternalAudioCapture(wasSuspended: suspended)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `external audio resumes in flight Voice Wake start`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager._test_setStartInFlight(true)

        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == true)
        #expect(manager.statusText == "Paused")

        manager._test_setStartInFlight(false)
        manager.resumeAfterExternalAudioCapture(wasSuspended: suspended)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `Talk suppression toggle does not leave Voice Wake externally suspended`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.isListening = true

        manager.setSuppressedByTalk(true)
        let suspended = manager.suspendForExternalAudioCapture()
        #expect(suspended == false)

        manager.setSuppressedByTalk(false)
        manager.resumeAfterExternalAudioCapture(wasSuspended: suspended)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
        #expect(manager.isListening == false)
    }

    @Test
    @MainActor func `clearing Talk suppression does not clobber voice note suppression`() async {
        let manager = VoiceWakeManager._test_withoutRestartDelays()
        manager.isEnabled = true
        manager.statusText = "Listening"

        manager.setSuppressedByVoiceNote(true)
        manager.setSuppressedByTalk(true)
        manager.setSuppressedByTalk(false)

        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Paused")
        #expect(manager.isListening == false)

        manager.setSuppressedByVoiceNote(false)
        await manager._test_waitForScheduledStart()
        #expect(manager.statusText == "Voice Wake isn’t supported on Simulator")
    }
}
