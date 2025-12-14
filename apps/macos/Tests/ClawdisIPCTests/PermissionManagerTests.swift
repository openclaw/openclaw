import Testing
import ClawdisIPC
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct PermissionManagerTests {
    @Test func voiceWakePermissionHelpersMatchStatus() async {
        let direct = PermissionManager.voiceWakePermissionsGranted()
        let ensured = await PermissionManager.ensureVoiceWakePermissions(interactive: false)
        #expect(ensured == direct)
    }

    @Test func statusCanQueryNonInteractiveCaps() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let status = await PermissionManager.status(caps)
        #expect(status.keys.count == caps.count)
    }

    @Test func ensureNonInteractiveDoesNotThrow() async {
        let caps: [Capability] = [.microphone, .speechRecognition, .screenRecording]
        let ensured = await PermissionManager.ensure(caps, interactive: false)
        #expect(ensured.keys.count == caps.count)
    }
}
