import Testing
@testable import OpenClawChatUI

@Suite struct ChatAutoScrollPolicyTests {
    @Test func streamingAutoScrollRequiresInitialBottomAndEnabledToggle() {
        #expect(ChatAutoScrollPolicy.shouldScrollForStreaming(
            hasPerformedInitialScroll: true,
            isPinnedToBottom: true,
            autoScrollDuringStreaming: true))

        #expect(!ChatAutoScrollPolicy.shouldScrollForStreaming(
            hasPerformedInitialScroll: false,
            isPinnedToBottom: true,
            autoScrollDuringStreaming: true))
        #expect(!ChatAutoScrollPolicy.shouldScrollForStreaming(
            hasPerformedInitialScroll: true,
            isPinnedToBottom: false,
            autoScrollDuringStreaming: true))
        #expect(!ChatAutoScrollPolicy.shouldScrollForStreaming(
            hasPerformedInitialScroll: true,
            isPinnedToBottom: true,
            autoScrollDuringStreaming: false))
    }
}
