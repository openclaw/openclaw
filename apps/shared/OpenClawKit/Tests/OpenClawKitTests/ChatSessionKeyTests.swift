import OpenClawChatUI
import Testing

struct ChatSessionKeyTests {
    @Test(arguments: [
        (" chat-1\n", "CHAT-1", true),
        ("main", "agent:main:main", true),
        (" AGENT:MAIN:MAIN ", "main", true),
        ("main", "agent:other:main", false),
        ("agent:main:other", "other", false),
        ("chat-1", "chat-2", false),
    ])
    func `Talk matches session keys without admitting other agent or named-session aliases`(
        incoming: String,
        current: String,
        matches: Bool)
    {
        #expect(OpenClawChatSessionKey.matchesIncludingDefaultMainAlias(incoming, current) == matches)
    }
}
