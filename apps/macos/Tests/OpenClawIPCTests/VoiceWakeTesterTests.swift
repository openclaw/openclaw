import Foundation
import SwabbleKit
import Testing

struct VoiceWakeTesterTests {
    @Test func `match respects gap requirement`() {
        let transcript = "hey claude do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("claude", 0.2, 0.1),
                ("do", 0.35, 0.1),
                ("thing", 0.5, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["claude"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config) == nil)
    }

    @Test func `match returns command after gap`() {
        let transcript = "hey claude do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("claude", 0.2, 0.1),
                ("do", 0.8, 0.1),
                ("thing", 1.0, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["claude"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config)?.command == "do thing")
    }
}
