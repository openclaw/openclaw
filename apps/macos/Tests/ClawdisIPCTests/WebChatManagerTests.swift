import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func preferredSessionKeyIsMain() {
        #expect(WebChatManager.shared.preferredSessionKey() == "main")
    }
}
