import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionAttentionTests {
    @Test func `group attention selects the globally oldest kind and counts only that kind`() {
        let child = OpenClawChatSessionEntry.placeholder(key: "agent:main:child")
        let parent = OpenClawChatSessionEntry.placeholder(key: "agent:main:parent")
        let oldestQuestion = self.request("question-old", kind: .question, key: child.key, created: 1)
        let oldestApproval = self.request("approval-old", kind: .approval, key: parent.key, created: 2)
        let requests = [
            self.request("question-new", kind: .question, key: parent.key, created: 3),
            self.request("approval-new", kind: .approval, key: child.key, created: 4),
            oldestQuestion, oldestApproval, oldestQuestion,
            self.request("expired", kind: .question, key: child.key, created: 0, expires: 1000),
            self.request("foreign", kind: .approval, key: "agent:work:child", created: 0),
        ]
        let summary = self.summary(requests, sessions: [parent, child, child])
        #expect(summary?.kind == .question)
        #expect(summary?.oldest.id == "question-old")
        #expect(summary?.count == 2)
        #expect(summary?.oldest.preview == "Preview question-old")
        #expect(summary?.additionalRequestsText == "1 more question")
        let afterQuestion = self.summary(requests.filter { $0.id != "question-old" }, sessions: [parent, child])
        #expect(afterQuestion?.kind == .approval)
        #expect(afterQuestion?.oldest.id == "approval-old")
        #expect(afterQuestion?.count == 2)
    }

    @Test func `attention source aliases respect the active agent and missing provenance stays unassigned`() {
        var global = OpenClawChatSessionEntry.placeholder(key: "global")
        global.agentId = "work"
        let requests = [
            self.request("owned", kind: .question, key: "global", agentID: "work"),
            self.request("foreign", kind: .question, key: "global", agentID: "main"),
            self.request("unknown", kind: .approval, key: nil, agentID: "work"),
        ]
        let summary = self.summary(requests, sessions: [global], agentID: "work")
        #expect(summary?.oldest.id == "owned")
        #expect(summary?.count == 1)
        #expect(self.summary(requests, sessions: [global], agentID: "main")?.oldest.id == "owned")
        let main = OpenClawChatSessionEntry.placeholder(key: "agent:main:main")
        #expect(self.summary([
            self.request("main-alias", kind: .approval, key: "main"),
        ], sessions: [main])?.oldest.id == "main-alias")
    }

    @Test func `equal creation times have deterministic preview ordering and expiry removes the badge`() {
        let session = OpenClawChatSessionEntry.placeholder(key: "main")
        let requests = [
            self.request("b", kind: .approval, key: "main", expires: 1001),
            self.request("a", kind: .approval, key: "main", expires: 1001),
        ]
        #expect(self.summary(requests, sessions: [session])?.oldest.id == "a")
        #expect(ChatSessionSidebarModel.attentionSummary(
            requests: requests, sessions: [session], mainSessionKey: "agent:main:main",
            activeAgentID: "main", sessionRoutingContract: nil,
            now: Date(timeIntervalSince1970: 1.001)) == nil)
    }

    @Test func `opaque approval ids remain byte distinct across Unicode normalization`() {
        let session = OpenClawChatSessionEntry.placeholder(key: "main")
        let summary = self.summary([
            self.request("approval-é", kind: .approval, key: "main"),
            self.request("approval-e\u{0301}", kind: .approval, key: "main"),
        ], sessions: [session])
        #expect(summary?.count == 2)
        #expect(summary.map { Data($0.oldest.id.utf8) } == Data("approval-e\u{0301}".utf8))
    }

    @Test func `attention previews normalize whitespace and stop before a split UTF16 scalar`() {
        let normalized = OpenClawChatAttentionRequest(
            id: "preview", kind: .question, sessionKey: "main", agentID: "main",
            createdAtMs: 1, expiresAtMs: 5000, preview: "  First\n\tsecond  third  ")
        #expect(normalized.preview == "First second third")
        let long = OpenClawChatAttentionRequest(
            id: "long", kind: .approval, sessionKey: "main", agentID: "main",
            createdAtMs: 1, expiresAtMs: 5000,
            preview: String(repeating: "a", count: 238) + "😀tail")
        #expect(long.preview == String(repeating: "a", count: 238) + "…")
        #expect(long.preview.utf16.count <= 240)
    }

    @Test func `disclosure identity follows its owner and request while ignoring background count changes`() throws {
        let session = OpenClawChatSessionEntry.placeholder(key: "main")
        func summary(
            ownerID: String = "gateway-a",
            id: String = "oldest",
            created: Double = 1,
            count: Int = 2,
            preview: String = "Original request") throws -> OpenClawChatAttentionSummary
        {
            try #require(self.summary([
                OpenClawChatAttentionRequest(
                    id: id, kind: .question, sessionKey: "main", agentID: "main",
                    createdAtMs: created, expiresAtMs: 5000, preview: preview, count: count, ownerID: ownerID),
            ], sessions: [session]))
        }
        let original = try summary()
        #expect(try summary(count: 1, preview: "Updated preview").disclosureIdentity == original.disclosureIdentity)
        #expect(try summary(ownerID: "gateway-b").disclosureIdentity != original.disclosureIdentity)
        #expect(try summary(id: "replacement").disclosureIdentity != original.disclosureIdentity)
        #expect(try summary(created: 2).disclosureIdentity != original.disclosureIdentity)
        #expect(OpenClawChatAttentionPresentation(targetID: "agent", requestID: original.disclosureIdentity) !=
            OpenClawChatAttentionPresentation(targetID: "session", requestID: original.disclosureIdentity))
    }

    private func summary(
        _ requests: [OpenClawChatAttentionRequest],
        sessions: [OpenClawChatSessionEntry],
        agentID: String = "main") -> OpenClawChatAttentionSummary?
    {
        ChatSessionSidebarModel.attentionSummary(
            requests: requests, sessions: sessions, mainSessionKey: "agent:\(agentID):main",
            activeAgentID: agentID, sessionRoutingContract: nil, now: Date(timeIntervalSince1970: 1))
    }

    private func request(
        _ id: String,
        kind: OpenClawChatAttentionRequest.Kind,
        key: String?,
        agentID: String = "main",
        created: Double = 1,
        expires: Double = 5000) -> OpenClawChatAttentionRequest
    {
        OpenClawChatAttentionRequest(
            id: id, kind: kind, sessionKey: key, agentID: agentID,
            createdAtMs: created, expiresAtMs: expires, preview: "Preview \(id)")
    }
}
