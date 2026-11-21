// Transplanted unchanged into baseline and candidate by the hosted proof driver.
// Calls the real ensure -> Speech API path; only the OS response is synthetic.
import OpenClawWebKitTestSupport
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct Goal24SpeechFrameworkBoundaryTests {
    @Test func offMainFrameworkCompletion() async throws {
        try #require(Goal24InstallSpeechFixture())
        defer { Goal24RestoreSpeechFixture() }
        let result = await PermissionManager.ensure([.speechRecognition], interactive: true)
        MainActor.assertIsolated()
        #expect(result[.speechRecognition] == true)
        #expect(Goal24SpeechRequestCount() == 1)
    }
}
