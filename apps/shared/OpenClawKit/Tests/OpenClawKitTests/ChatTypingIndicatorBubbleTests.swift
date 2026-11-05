import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatTypingIndicatorBubbleTests {
    @Test
    func `avatar tint changes invalidate the equatable typing indicator`() {
        let original = Self.bubble(tint: .red)
        #expect(original == Self.bubble(tint: .red))
        #expect(original != Self.bubble(tint: .blue))
        #expect(original != Self.bubble(tint: nil))
    }

    private static func bubble(tint: Color?) -> ChatTypingIndicatorBubble {
        ChatTypingIndicatorBubble(
            style: .standard,
            assistantName: "Assistant",
            assistantAvatarText: "A",
            assistantAvatarTint: tint,
            showsAssistantAvatar: true,
            isClean: true,
            runIdentity: "synthetic-run",
            outputTokens: nil)
    }
}
