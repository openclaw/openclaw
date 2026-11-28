import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor struct ChatPRVisibilityTests {
    @Test func `hiding survives relaunch without following other P rs or chats`() throws {
        let suite = "ChatPRVisibilityTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let chat = OpenClawChatSessionTarget(sessionKey: "main", agentID: "demo")
        let scope = ChatPRVisibility.scope(gateway: "one", target: chat)
        let store = ChatPRVisibility(defaults: defaults)
        store.setHidden(true, ids: ["Paper/Trail#1"], in: scope)
        let fresh = ChatPRVisibility(defaults: defaults)
        #expect(fresh.hidden(in: scope) == ["paper/trail#1"])
        #expect(!fresh.hidden(in: scope).contains("paper/trail#2"))
        #expect(fresh.hidden(in: ChatPRVisibility.scope(gateway: "two", target: chat)).isEmpty)
        #expect(fresh.hidden(in: ChatPRVisibility.scope(
            gateway: "one",
            target: .init(sessionKey: "main", agentID: "other"))).isEmpty)
        fresh.setHidden(true, ids: ["paper/trail#2"], in: scope)
        fresh.setHidden(false, ids: ["paper/trail#1"], in: scope)
        #expect(fresh.hidden(in: scope) == ["paper/trail#2"])
        fresh.setHidden(false, ids: ["paper/trail#2"], in: scope)
        #expect(ChatPRVisibility(defaults: defaults).hidden(in: scope).isEmpty)
    }
}
