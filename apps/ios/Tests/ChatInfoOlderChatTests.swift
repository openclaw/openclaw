import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct ChatInfoOlderChatTests {
    @Test func `details of a chat the roster leaves out keep its name`() throws {
        let key = "agent:main:field-notes"
        let model = OpenClawChatViewModel(
            sessionKey: key,
            transport: LocalFixtureChatTransport(fixture: .appScreenshots))
        defer { model.detachTransport() }
        // The capped roster holds newer chats only; the chat's own history row is kept on the side.
        model.sessions = [OpenClawChatSessionEntry(key: "agent:main:newer", label: "Newer chat")]
        model.retainedActiveSession = OpenClawChatSessionEntry(key: key, label: "Field recording plan")
        #expect(model.currentSessionEntry() == nil)

        let visit = ChatInfoVisit(
            model: model,
            kind: .chat,
            agentName: "Agent",
            badge: "A",
            avatar: nil,
            gatewayID: nil,
            agentID: "main")
        let session = try #require(visit.session)
        #expect(SessionPresentation.title(session, includesRoutingFallback: false) == "Field recording plan")
    }
}
