import Foundation
import Testing
@testable import OpenClaw

@Suite struct TalkModeIncrementalTests {
    @Test @MainActor func incrementalSpeechSplitsOnBoundary() {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode._test_incrementalReset()
        let segments = talkMode._test_incrementalIngest("Hello world. Next", isFinal: false)
        #expect(segments.count == 1)
        #expect(segments.first == "Hello world.")
    }

    @Test @MainActor func incrementalSpeechSkipsDirectiveLine() {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode._test_incrementalReset()
        let segments = talkMode._test_incrementalIngest("{\"voice\":\"abc\"}\nHello.", isFinal: false)
        #expect(segments.count == 1)
        #expect(segments.first == "Hello.")
    }

    @Test @MainActor func incrementalSpeechIgnoresCodeBlocks() {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        talkMode._test_incrementalReset()
        let text = "Here is code:\n```js\nx=1\n```\nDone."
        let segments = talkMode._test_incrementalIngest(text, isFinal: true)
        #expect(segments.count == 1)
        let value = segments.first ?? ""
        #expect(value.contains("x=1") == false)
        #expect(value.contains("Here is code") == true)
        #expect(value.contains("Done.") == true)
    }
}
