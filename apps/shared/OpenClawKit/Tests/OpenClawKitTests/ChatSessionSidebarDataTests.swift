import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarDataTests {
    private let original = #"""
    {"key":"agent:main:thread","agentId":"main","sessionId":"thread","label":"Original",
     "updatedAt":10,"model":"fixture-before","thinkingLevel":"off","contextTokens":100,
     "hasActiveRun":true,"activeRunIds":["run"],"observerDigest":{"agentId":"main","runId":"run",
     "revision":1,"updatedAt":10,"headline":"Working","health":"on-track"}}
    """#

    private func rows(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: Data(#"{"sessions":[\#(json)]}"#.utf8)).sessions
    }

    private func receipt(_ json: String, agentID: String = "main") throws -> OpenClawChatSessionPatchReceipt {
        var receipt = try JSONDecoder().decode(OpenClawChatSessionPatchReceipt.self, from: Data(json.utf8))
        receipt.agentID = agentID
        return receipt
    }

    private func observer(sessionID: String = "thread", runID: String = "run") throws -> SessionObserverDigest {
        try JSONDecoder().decode(SessionObserverDigest.self, from: Data(#"""
        {"sessionKey":"agent:main:thread","agentId":"main","sessionId":"\#(sessionID)","runId":"\#(runID)",
         "revision":2,"updatedAt":20,"headline":"Needs input","health":"waiting-on-user"}
        """#.utf8))
    }

    @Test func `unchanged roster projections compute once per scope and refresh after mutations`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let ids = try owner.receive(self.rows(self.original), read: owner.beginRead(), replacingAgent: "main")
        var counts: [OpenClawChatSessionSidebarData.Projection: Int] = [:]
        owner.onProjectionComputed = { counts[$0, default: 0] += 1 }
        for _ in 0..<20 {
            #expect(owner.conversationRows(agentID: "main").first?.label == "Original")
            #expect(owner.conversationRows(agentID: "other").isEmpty)
            #expect(owner.project(ids).first?.label == "Original")
        }
        #expect(counts[.conversation("main")] == 1)
        #expect(counts[.conversation("other")] == 1)
        #expect(counts[.members(ids)] == 1)
        let target = try #require(owner.project(ids).first)
        let token = owner.beginMutation(target: target, field: .label) { $0.label = "Pending" }
        for _ in 0..<20 {
            #expect(owner.conversationRows(agentID: "main").first?.label == "Pending")
            #expect(owner.project(ids).first?.label == "Pending")
        }
        #expect(counts[.conversation("main")] == 2)
        #expect(counts[.members(ids)] == 2)
        owner.finishMutation(token, receipt: nil)
        #expect(owner.conversationRows(agentID: "main").first?.label == "Original")
        #expect(counts[.conversation("main")] == 3)
    }

    @Test func `authoritative refresh replaces membership without invalidating transient references`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let initial = try self.rows(self.original + #",{"key":"agent:main:removed","sessionId":"removed"}"#)
        let initialIDs = owner.receive(initial, read: owner.beginRead(), replacingAgent: "main")
        let transient = try owner.receive(self.rows(
            #"{"key":"agent:main:remote","sessionId":"remote","label":"Remote"}"#), read: owner.beginRead())
        #expect(Set(owner.conversationRows(agentID: "main").map(\.sessionId)) == ["thread", "removed"])
        #expect(owner.project(transient).first?.label == "Remote")

        let fresh = try self.rows(#"""
        {"key":"agent:main:thread","agentId":"main","sessionId":"thread","label":"Refreshed","updatedAt":30}
        """#)
        owner.receive(fresh, read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["thread"])
        #expect(owner.project(initialIDs).first?.label == "Refreshed")
        #expect(owner.project(transient).first?.label == "Remote")

        let remoteRefresh = try self.rows(#"""
        {"key":"agent:main:thread","agentId":"main","sessionId":"thread","label":"Palette result","updatedAt":40}
        """#)
        let references = owner.receive(remoteRefresh, read: owner.beginRead())
        #expect(owner.conversationRows(agentID: "main").first?.label == "Palette result")
        #expect(owner.project(references).first?.label == "Palette result")
    }

    @Test func `older roster responses cannot restore superseded membership or local settings`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let initial = try self.rows(self.original)
        owner.receive(initial, read: owner.beginRead(), replacingAgent: "main")
        let oldRead = owner.beginRead()
        let fresh = try self.rows(#"{"key":"agent:main:new","sessionId":"new","label":"New roster"}"#)
        owner.receive(fresh, read: owner.beginRead(), replacingAgent: "main")
        owner.receive(initial, read: oldRead, replacingAgent: "main")
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["new"])

        owner.receive(initial, read: owner.beginRead(), replacingAgent: "main")
        let staleSettings = owner.beginRead()
        var edited = owner.conversationRows(agentID: "main")
        edited[0].model = "fixture-after"
        edited[0].thinkingLevel = "high"
        edited[0].contextTokens = 200
        owner.replaceConversationRows(edited, agentID: "main")
        owner.receive(initial, read: staleSettings)
        let current = try #require(owner.row(key: "agent:main:thread", agentID: "main"))
        #expect(current.model == "fixture-after")
        #expect(current.thinkingLevel == "high")
        #expect(current.contextTokens == 200)
    }

    @Test func `observer facts survive older snapshots only within the same active incarnation`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let initial = try self.rows(self.original)
        owner.receive(initial, read: owner.beginRead(), replacingAgent: "main")
        let delayedRead = owner.beginRead()
        try owner.applyObserver(self.observer())
        let references = owner.receive(initial, read: delayedRead)
        #expect(owner.project(references).first?.observerDigest?.health == "waiting-on-user")
        #expect(owner.conversationRows(agentID: "main").first?.observerDigest?.revision == 2)

        let replacements = [
            #"{"key":"agent:main:thread","sessionId":"thread","hasActiveRun":true,"activeRunIds":["next-run"]}"#,
            #"{"key":"agent:main:thread","sessionId":"replacement","hasActiveRun":true,"activeRunIds":["run"]}"#,
            #"{"key":"agent:main:thread","sessionId":"thread","hasActiveRun":false,"activeRunIds":[]}"#,
        ]
        for replacement in replacements {
            owner.receive(initial, read: owner.beginRead())
            try owner.applyObserver(self.observer())
            let ids = try owner.receive(self.rows(replacement), read: owner.beginRead())
            try owner.applyObserver(self.observer())
            #expect(owner.project(ids).first?.observerDigest == nil)
        }
    }

    @Test func `failed pending edits reveal current observer and settings facts without committing the overlay`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let references = try owner.receive(self.rows(self.original), read: owner.beginRead(), replacingAgent: "main")
        let target = try #require(owner.project(references).first)
        let token = owner.beginMutation(target: target, field: .label) { $0.label = "Pending" }
        #expect(owner.project(references).first?.label == "Pending")
        try owner.applyObserver(self.observer())
        var edited = owner.conversationRows(agentID: "main")
        edited[0].model = "fixture-after"
        edited[0].thinkingLevel = "high"
        owner.replaceConversationRows(edited, agentID: "main")
        owner.finishMutation(token, receipt: nil)

        let row = try #require(owner.project(references).first)
        #expect(row.label == "Original")
        #expect(row.model == "fixture-after")
        #expect(row.thinkingLevel == "high")
        #expect(row.observerDigest?.health == "waiting-on-user")
    }

    @Test func `acknowledged fields survive an older read while failed newer intent reveals the acknowledgement`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let initial = try self.rows(self.original)
        let ids = owner.receive(initial, read: owner.beginRead(), replacingAgent: "main")
        let target = try #require(owner.project(ids).first)
        let older = owner.beginMutation(target: target, field: .label) { $0.label = "First pending" }
        let newer = owner.beginMutation(target: target, field: .label) { $0.label = "Second pending" }
        let delayedRead = owner.beginRead()
        try owner.applyObserver(self.observer())
        try owner.finishMutation(older, receipt: self.receipt(#"""
        {"key":"agent:main:thread","entry":{"sessionId":"thread","label":"Confirmed","updatedAt":20}}
        """#))
        #expect(owner.project(ids).first?.label == "Second pending")
        owner.receive(initial, read: delayedRead)
        owner.finishMutation(newer, receipt: nil)
        #expect(owner.project(ids).first?.label == "Confirmed")
        #expect(owner.project(ids).first?.observerDigest?.health == "waiting-on-user")

        try owner.receive(self.rows(#"""
        {"key":"agent:main:thread","sessionId":"thread","label":"External rename","updatedAt":30}
        """#), read: owner.beginRead())
        #expect(owner.project(ids).first?.label == "External rename")
    }

    @Test func `delayed rename acknowledgement changes only its field after a newer lifecycle update`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let ids = try owner.receive(self.rows(self.original), read: owner.beginRead(), replacingAgent: "main")
        let target = try #require(owner.project(ids).first)
        let token = owner.beginMutation(target: target, field: .label) { $0.label = "Pending rename" }
        var lifecycle = owner.conversationRows(agentID: "main")
        #expect(lifecycle.first?.label == "Pending rename")
        lifecycle[0].updatedAt = 30
        lifecycle[0].lastActivityAt = 30
        lifecycle[0].status = "running"
        owner.replaceConversationRows(lifecycle, agentID: "main")
        try owner.finishMutation(token, receipt: self.receipt(#"""
        {"key":"agent:main:thread","entry":{"sessionId":"thread","label":"Acknowledged rename","updatedAt":20}}
        """#))

        let current = try #require(owner.project(ids).first)
        #expect(current.label == "Acknowledged rename")
        #expect(current.updatedAt == 30)
        #expect(current.lastActivityAt == 30)
        #expect(current.status == "running")
    }

    @Test func `foreign and archived transient rows remain scoped and share canonical mutation facts`() throws {
        let owner = OpenClawChatSessionSidebarData()
        try owner.receive(self.rows(self.original), read: owner.beginRead(), replacingAgent: "main")
        let refs = try owner.receive(self.rows(#"""
        {"key":"global","agentId":"alpha","sessionId":"alpha","label":"Archived alpha","archived":true,"archivedAt":5},
        {"key":"global","agentId":"beta","sessionId":"beta","label":"Beta","unread":false}
        """#), read: owner.beginRead())
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["thread"])
        #expect(owner.project(refs).map(\.sessionId) == ["alpha", "beta"])
        let alpha = try #require(owner.row(key: "global", agentID: "alpha"))
        let token = owner.beginMutation(target: alpha, field: .label) { $0.label = "Renamed alpha" }
        #expect(owner.row(key: "global", agentID: "beta")?.label == "Beta")
        try owner.finishMutation(token, receipt: self.receipt(#"""
        {"key":"global","entry":{"sessionId":"alpha","label":"Renamed alpha","updatedAt":20}}
        """#, agentID: "alpha"))
        #expect(owner.project(refs).first?.label == "Renamed alpha")
        #expect(owner.project(refs).first?.isArchived == true)
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["thread"])

        owner.receive([alpha], read: owner.beginRead(), replacingAgent: "alpha")
        #expect(owner.conversationRows(agentID: "alpha").isEmpty)
        #expect(owner.conversationRows(agentID: "beta").isEmpty)
        #expect(owner.row(key: "global", agentID: "beta")?.label == "Beta")
        var beta = try #require(owner.row(key: "global", agentID: "beta"))
        beta.model = "fixture-next"
        owner.replaceConversationRows(owner.conversationRows(agentID: "main") + [beta], agentID: "main")
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["thread"])
        #expect(owner.row(key: "global", agentID: "beta")?.model == "fixture-next")
    }

    @Test func `failed archive restores membership after an unrelated local settings write`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let rows = try self
            .rows(self.original + #",{"key":"agent:main:other","sessionId":"other","model":"fixture-before"}"#)
        owner.receive(rows, read: owner.beginRead(), replacingAgent: "main")
        let target = try #require(owner.row(key: "agent:main:thread", agentID: "main"))
        let archive = owner.beginMutation(target: target, field: .archived) { $0.archived = true }
        var visible = owner.conversationRows(agentID: "main")
        #expect(visible.map(\.sessionId) == ["other"])
        visible[0].model = "fixture-after"
        owner.replaceConversationRows(visible, agentID: "main")
        owner.finishMutation(archive, receipt: nil)

        #expect(Set(owner.conversationRows(agentID: "main").map(\.sessionId)) == ["thread", "other"])
        #expect(owner.row(key: "agent:main:other", agentID: "main")?.model == "fixture-after")
        #expect(owner.row(key: "agent:main:thread", agentID: "main")?.isArchived == false)
    }

    @Test func `ordinary reads preserve omitted enrichment only for the same incarnation`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let ids = try owner.receive(self.rows(#"""
        {"key":"agent:main:thread","sessionId":"thread","derivedTitle":"Derived before",
         "lastMessagePreview":"Preview before","updatedAt":10}
        """#), read: owner.beginRead(), replacingAgent: "main")
        try owner.receive(self.rows(#"""
        {"key":"agent:main:thread","sessionId":"thread","label":"Renamed","updatedAt":20}
        """#), read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.project(ids).first?.label == "Renamed")
        #expect(owner.project(ids).first?.derivedTitle == "Derived before")
        #expect(owner.project(ids).first?.lastMessagePreview == "Preview before")
        try owner.receive(self.rows(#"""
        {"key":"agent:main:thread","sessionId":"thread","derivedTitle":"Derived after",
         "lastMessagePreview":"Preview after","updatedAt":30}
        """#), read: owner.beginRead())
        #expect(owner.project(ids).first?.derivedTitle == "Derived after")
        #expect(owner.project(ids).first?.lastMessagePreview == "Preview after")
        try owner.receive(self.rows(#"""
        {"key":"agent:main:thread","sessionId":"replacement","updatedAt":40}
        """#), read: owner.beginRead())
        #expect(owner.project(ids).first?.derivedTitle == nil)
        #expect(owner.project(ids).first?.lastMessagePreview == nil)
    }

    @Test(arguments: [false, true])
    func `retired reads and mutation callbacks cannot populate a new scope or incarnation`(
        invalidateScope: Bool) throws
    {
        let owner = OpenClawChatSessionSidebarData()
        let original = try self.rows(self.original)
        let ids = owner.receive(original, read: owner.beginRead(), replacingAgent: "main")
        let target = try #require(owner.project(ids).first)
        let staleRead = owner.beginRead()
        let old = owner.beginMutation(target: target, field: .label) { $0.label = "Old intent" }
        if invalidateScope { owner.invalidate(clear: true) }
        let replacement = try self.rows(#"""
        {"key":"agent:main:thread","sessionId":"replacement","label":"Replacement","updatedAt":30}
        """#)
        owner.receive(replacement, read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.receive(original, read: staleRead).isEmpty == invalidateScope)
        try owner.finishMutation(old, receipt: self.receipt(#"""
        {"key":"agent:main:thread","entry":{"sessionId":"thread","label":"Old acknowledgement","updatedAt":40}}
        """#))
        owner.remove(target)
        #expect(owner.conversationRows(agentID: "main").first?.label == "Replacement")
        #expect(owner.conversationRows(agentID: "main").first?.sessionId == "replacement")
    }
}
