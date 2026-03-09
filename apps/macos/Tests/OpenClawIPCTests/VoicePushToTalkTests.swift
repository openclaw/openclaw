import Testing
@testable import OpenClaw

struct VoicePushToTalkTests {
    @Test func `delta trims committed prefix`() {
        let delta = VoicePushToTalk._testDelta(committed: "hello ", current: "hello world again")
        #expect(delta == "world again")
    }

    @Test func `delta falls back when prefix differs`() {
        let delta = VoicePushToTalk._testDelta(committed: "goodbye", current: "hello world")
        #expect(delta == "hello world")
    }

    @Test func `attributed colors differ when not final`() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: false)
        #expect(colors.0 != colors.1)
    }

    @Test func `attributed colors match when final`() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: true)
        #expect(colors.0 == colors.1)
    }
}
