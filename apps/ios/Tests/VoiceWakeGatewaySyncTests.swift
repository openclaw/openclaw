import Foundation
import Testing
@testable import OpenClaw

struct VoiceWakeGatewaySyncTests {
    @Test func `decode gateway triggers from JSON sanitizes`() {
        let payload = #"{"triggers":[" openclaw  ","", "computer"]}"#
        let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: Data(payload.utf8))
        #expect(triggers == ["openclaw", "computer"])
    }

    @Test func `decode gateway triggers from JSON falls back when empty`() {
        let payload = #"{"triggers":["  ",""]}"#
        let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: Data(payload.utf8))
        #expect(triggers == VoiceWakePreferences.defaultTriggerWords)
    }

    @Test func `decode gateway triggers from invalid JSON returns nil`() {
        let triggers = VoiceWakePreferences.decodeGatewayTriggers(from: Data("not json".utf8))
        #expect(triggers == nil)
    }
}
