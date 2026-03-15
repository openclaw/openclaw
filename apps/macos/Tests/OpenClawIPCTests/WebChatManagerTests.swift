import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func `preferred session key is non empty`() async {
        let key = await WebChatManager.shared.preferredSessionKey()
        #expect(!key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
}
