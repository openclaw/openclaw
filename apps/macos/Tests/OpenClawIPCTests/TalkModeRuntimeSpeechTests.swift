import Speech
import Testing
@testable import OpenClaw

struct TalkModeRuntimeSpeechTests {
    @Test func `speech request uses dictation defaults`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        TalkModeRuntime.configureRecognitionRequest(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
    }
}
