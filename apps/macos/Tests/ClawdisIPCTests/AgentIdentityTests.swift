import Foundation
import Testing
@testable import Clawdis

@Suite
struct AgentIdentityTests {
    @Test
    func isEmptyTreatsWhitespaceAsEmpty() {
        #expect(AgentIdentity(name: " ", theme: "\n", emoji: "\t").isEmpty == true)
        #expect(AgentIdentity(name: "Pi", theme: "", emoji: "").isEmpty == false)
    }

    @Test
    func emojiSuggestMatchesKnownThemes() {
        #expect(AgentIdentityEmoji.suggest(theme: "") == "🦞")
        #expect(AgentIdentityEmoji.suggest(theme: "shark") == "🦈")
        #expect(AgentIdentityEmoji.suggest(theme: "  Octopus helper  ") == "🐙")
        #expect(AgentIdentityEmoji.suggest(theme: "unknown") == "🦞")
    }
}

