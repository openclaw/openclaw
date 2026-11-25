import Testing
@testable import OpenClawChatUI

/// The reactions pill follows the Control UI tab: the three most used faces, ties in arrival order,
/// and a total that counts every person on every emoji.
struct ChatReactionSummaryTests {
    private static func reaction(_ emoji: String, _ count: Int) -> OpenClawChatReactionSummary {
        OpenClawChatReactionSummary(emoji: emoji, count: count, identities: [])
    }

    @Test func `no reactions has no pill`() {
        #expect(ChatReactionSummary([]) == nil)
    }

    @Test func `one reaction shows its face and a total of one`() throws {
        let summary = try #require(ChatReactionSummary([Self.reaction("❤️", 1)]))
        #expect(summary.faces == ["❤️"])
        #expect(summary.total == 1)
    }

    @Test func `the three most used faces show, ties keep arrival order`() throws {
        let summary = try #require(ChatReactionSummary([
            Self.reaction("👍", 1), Self.reaction("🎉", 3), Self.reaction("👀", 2),
            Self.reaction("🚀", 3), Self.reaction("😂", 1),
        ]))
        #expect(summary.faces == ["🎉", "🚀", "👀"])
        #expect(summary.total == 10)
    }
}
