import Testing
@testable import OpenClawChatUI

/// A held agent reply shows its opening prose above the menu, not its code or diagram source.
struct ChatReplyMenuPreviewTests {
    @Test func `prose skips fenced blocks and heading marks`() {
        let reply = "## Plan\nA small release workflow:\n\n```mermaid\nflowchart TD\n  Draft --> Review\n```\nThen ship."
        #expect(ChatReplyMenuPreview.prose(reply) == "Plan\nA small release workflow:\n\nThen ship.")
    }

    @Test func `a reply that is only code keeps it`() {
        let reply = "```swift\nlet copied = true\n```"
        #expect(ChatReplyMenuPreview.prose(reply) == reply)
    }
}
