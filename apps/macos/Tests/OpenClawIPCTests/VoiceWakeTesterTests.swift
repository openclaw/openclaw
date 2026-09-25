import SwabbleKit
import Testing
@testable import OpenClaw

struct VoiceWakeTesterTests {
    @Test func `trigger only fallback accepts bare test trigger`() {
        let match = VoiceWakeRecognitionDebugSupport.triggerOnlyFallbackMatch(
            transcript: "hey openclaw",
            triggers: ["openclaw"],
            trimWake: { WakeWordGate.stripWake(text: $0, triggers: $1) })

        #expect(match?.command == "")
        #expect(match?.trigger == "openclaw")
    }

    @Test func `trigger only fallback rejects trailing mention`() {
        let match = VoiceWakeRecognitionDebugSupport.triggerOnlyFallbackMatch(
            transcript: "tell me about openclaw",
            triggers: ["openclaw"],
            trimWake: { WakeWordGate.stripWake(text: $0, triggers: $1) })

        #expect(match == nil)
    }
}
