#if os(macOS)
import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatSessionSidebarRowTests {
    @Test @MainActor
    func `web badges preserve agent identity and never replace sharing draft or native facts`() throws {
        let owner = OpenClawWebConversation()
        owner.mode = .web
        owner.sessionFacts = try JSONDecoder().decode(NativeConversationSessionFacts.self, from: Data(#"""
        {"revision":1,"sessions":[
          {"agentId":"research","sessionKey":"shared","hasComposerDraft":true,"outboxAttentionCount":2},
          {"agentId":"main","sessionKey":"shared","hasComposerDraft":false,"outboxAttentionCount":8}
        ]}
        """#.utf8)).sessions
        let session = try self.session(#"{"key":"shared","agentId":"research","visibility":"draft"}"#)
        let context = NativeConversationContext(agentId: "research", sessionKey: "shared")
        func badges() -> [ChatSessionSidebarRowFacts.Badge] {
            ChatSessionSidebarRowFacts(
                node: ChatSessionSidebarModel.tree(from: [session])[0],
                isChild: false,
                attention: nil,
                showPreview: false,
                webFacts: owner.sidebarFacts(for: context),
                preview: nil,
                now: Date(timeIntervalSince1970: 2)).badges
        }
        #expect(badges().map(\.glyph) == [.emoji("👻"), .symbol("exclamationmark.triangle"), .symbol("pencil")])
        #expect(badges().compactMap(\.count) == [2])
        #expect(badges().last?.label == "Unsent draft")
        #expect(owner.sidebarFacts(for: .init(agentId: "missing", sessionKey: "shared")) == nil)
        owner.mode = .native
        #expect(badges().map(\.glyph) == [.emoji("👻")])
        owner.mode = .web
        owner.sessionFacts = nil
        #expect(badges().map(\.glyph) == [.emoji("👻")])
    }

    @Test(arguments: [
        (#"{"key":"agent:main:row","lastMessagePreview":"Server answer"}"#, true, "Server answer" as String?),
        (#"{"key":"agent:main:row","status":"failed","lastRunError":"Permission denied","endedAt":1000}"#, true, nil),
        (#"{"key":"agent:main:row","hasActiveRun":true,"status":"queued"}"#, false, nil),
        (
            #"{"key":"agent:main:row","agentStatus":{"note":"Need a decision","attention":"flag","expiresAt":99999}}"#,
            false,
            "Need a decision"),
    ])
    func `sidebar subtitle follows server preview and critical status precedence`(
        wire: String, showPreview: Bool, expected: String?) throws
    {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(wire.utf8))
        let facts = ChatSessionSidebarRowFacts(
            node: ChatSessionSidebarModel.tree(from: [session])[0],
            isChild: false,
            attention: nil,
            showPreview: showPreview,
            preview: "Cached answer",
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.subtitle == expected)
    }

    @Test func `leading state replaces decoration and suppresses unread while running`() throws {
        var session = try self.session(#"{"key":"agent:main:row","icon":"book","unread":true}"#)
        var facts = self.facts(session)
        #expect(facts.glyph == .symbol("book"))
        #expect(facts.unread && !facts.running)
        session.status = "queued"
        session.hasActiveRun = true
        facts = self.facts(session)
        #expect(facts.running && facts.queued && !facts.unread)
        session.hasActiveRun = false
        #expect(!self.facts(session).running)
        session.status = "failed"
        session.hasActiveRun = true
        session.endedAt = 1000
        session.lastRunError = "Permission denied"
        facts = self.facts(session)
        #expect(facts.glyph == .symbol("exclamationmark.triangle.fill"))
        #expect(!facts.running && facts.subtitle == nil)
        session.archived = true
        facts = self.facts(session)
        #expect(facts.glyph == .symbol("book"))
        #expect(!facts.running && !facts.unread && facts.attentionLabel == nil)
    }

    @Test func `question owns the leading slot while approval retains the run ring and critical subtitle`() throws {
        let session = try self.session(#"{"key":"agent:main:row","icon":"book","status":"running","unread":true}"#)
        for kind in [OpenClawChatAttentionRequest.Kind.question, .approval] {
            let request = OpenClawChatAttentionRequest(
                id: "request",
                kind: kind,
                sessionKey: session.key,
                agentID: "main",
                createdAtMs: 1,
                expiresAtMs: 99999,
                preview: "Choose a path")
            let attention = OpenClawChatAttentionSummary(kind: kind, oldest: request, count: 1)
            let facts = self.facts(session, attention: attention, showPreview: false)
            #expect(facts.glyph == .symbol(kind == .question ? "hand.raised.fill" : "checkmark.shield"))
            #expect(facts.running == (kind == .approval))
            #expect(!facts.unread)
            #expect(facts.subtitle == (kind == .approval ? "Waiting for approval" : nil))
        }
    }

    @Test func `critical observer requires the active run and ambient preview never replaces it`() throws {
        var session = try self.session(#"""
        {"key":"agent:main:row","status":"running","activeRunIds":["current"],
         "lastMessagePreview":"Old answer","observerDigest":{"agentId":"main","runId":"current",
         "revision":1,"updatedAt":1500,"headline":"Waiting for credentials","health":"waiting-on-user"}}
        """#)
        #expect(self.facts(session, showPreview: false).subtitle == "Waiting for credentials")
        session.activeRunIds = ["replacement"]
        #expect(self.facts(session).subtitle == nil)
    }

    @Test func `row badges preserve draft privacy fork archive and child workspace conflicts`() throws {
        var session = try self.session(#"""
        {"key":"agent:main:row","visibility":"draft","incognito":true,"archived":true,
         "forkSource":{"sessionKey":"parent","sessionId":"parent-id"},
         "placement":{"state":"active","generation":1,"createdAtMs":1,"updatedAtMs":1,"stateChangedAtMs":1,
           "providerId":"cloud","profileId":"small","machine":{"os":"linux","cpu":2,"memoryGb":4},
           "diskSpace":{"status":"critical"},"workspaceResultConflict":{"paths":["one"],"totalCount":3}}}
        """#)
        let badges = self.facts(session).badges
        #expect(badges.map(\.glyph) == [
            .emoji("👻"),
            .symbol("archivebox"),
            .symbol("arrow.triangle.branch"),
            .symbol("lock"),
            .symbol("globe"),
        ])
        #expect(badges.last?
            .label ==
            "cloud · small · linux · 2 vCPU · 4 GB · active · 3 workspace conflicts · " +
            "Cloud session disk space is critically low")
        #expect(badges.last?.tone == .warning)
        let childCloud = self.facts(session, isChild: true).badges.last
        #expect(childCloud?.glyph == .symbol("globe"))
        #expect(childCloud?.label.contains("disk space") == false)
        session.placement = try self.session(#"""
        {"key":"child","placement":{"state":"reclaimed","generation":1,"createdAtMs":1,"updatedAtMs":1,
         "stateChangedAtMs":1,"workspaceResultConflict":{"paths":["one"]}}}
        """#).placement
        #expect(self.facts(session, isChild: true).badges.last?.label == "Placement: reclaimed · 1 workspace conflict")
    }

    @Test(arguments: ["local", "reclaimed", "active", "failed"])
    func `ordinary child placement stays quiet while roots show cloud state`(state: String) throws {
        let session = try self.session("""
        {"key":"child","placement":{"state":"\(state)","generation":1,"createdAtMs":1,"updatedAtMs":1,
         "stateChangedAtMs":1,"diskSpace":{"status":"warning"}}}
        """)
        #expect(self.facts(session, isChild: true).badges.isEmpty)
        let badges = self.facts(session).badges
        #expect(badges.isEmpty == ["local", "reclaimed"].contains(state))
        if state == "failed" { #expect(badges.last?.tone == .danger) }
        if state == "active" { #expect(badges.last?.tone == .warning) }
    }

    @Test(arguments: [
        ("braces", "curlybraces"), ("book", "book"), ("monitor", "desktopcomputer"),
        ("bot", "cpu"), ("kanban", "rectangle.split.3x1"), ("coins", "dollarsign.circle"),
        ("data:image/svg+xml,%3Csvg%3E%3C/svg%3E", "text.bubble"), ("unrecognized", "text.bubble"),
    ])
    func `wire icons map to safe native glyphs`(wire: String, symbol: String) throws {
        let data = try JSONSerialization.data(withJSONObject: ["key": "agent:main:icon", "icon": wire])
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)
        #expect(self.facts(row).glyph == .symbol(symbol))
    }

    @Test func `emoji and child runtime retain their visible meaning`() throws {
        for icon in ["👩🏽‍💻", "1️⃣"] {
            let data = try JSONSerialization.data(withJSONObject: ["key": "agent:main:icon", "icon": icon])
            let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)
            #expect(self.facts(row).glyph == .emoji(icon))
        }
        var session = try self.session(#"{"key":"child","status":"running","runtimeMs":60000,"startedAt":1}"#)
        let sampledAt = Date(timeIntervalSince1970: 100)
        let now = sampledAt.addingTimeInterval(5)
        #expect(ChatSessionSidebarRowFacts.runtimeText(session, sampledAt: sampledAt, now: now) == "1m 5s")
        session.status = "done"
        #expect(ChatSessionSidebarRowFacts.runtimeText(session, sampledAt: sampledAt, now: now) == "1m")
        #expect(self.facts(session, isChild: true).glyph == .symbol("checkmark"))
        session.runtimeMs = 240
        #expect(ChatSessionSidebarRowFacts.runtimeText(session, sampledAt: sampledAt, now: now) == "240ms")
    }

    @Test func `working descendants replace an own queued ring`() throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(#"""
        [{"key":"parent","status":"queued","childSessions":["worker"]},
         {"key":"worker","status":"running","hasActiveRun":true}]
        """#.utf8))
        let node = try #require(ChatSessionSidebarModel.tree(from: rows).first)
        let facts = ChatSessionSidebarRowFacts(
            node: node,
            isChild: false,
            attention: nil,
            showPreview: true,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.running && !facts.queued)
    }

    @Test(arguments: ["child", "agent:main:subagent:worker"])
    @MainActor func `parent rows retain loaded descendant conflict and failure context`(childKey: String) throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(#"""
        [{"key":"parent","childSessions":["\#(childKey)"]},
         {"key":"\#(childKey)","label":"Worker","unread":true,"status":"failed",
           "lastRunError":"Permission denied","endedAt":1000,
          "placement":{"state":"reclaimed","generation":1,"createdAtMs":1,
          "updatedAtMs":1,"stateChangedAtMs":1,"workspaceResultConflict":{"paths":["one"],"totalCount":3}}}]
        """#.utf8))
        let node = try #require(ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "", viewOptions: .init()).flatMap(\.nodes).first)
        let facts = ChatSessionSidebarRowFacts(
            node: node,
            isChild: false,
            attention: nil,
            showPreview: false,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.badges.last?.glyph == .symbol("globe"))
        #expect(facts.badges.last?.label == "Cloud worker children: 3 workspace conflicts")
        #expect(facts.badges.last?.tone == .warning)
        #expect(facts.attentionLabel == "Child session Worker failed: Permission denied")
        #expect(facts.unreadDescendants)
        #expect(facts.failedDescendants)
    }

    @Test(arguments: [
        (#"{"key":"agent:main:slack:direct:user","label":"Alice","channel":"telegram"}"#, "Slack" as String?),
        (#"{"key":"agent:main:telegram:default:direct:user","label":"Alice"}"#, "Telegram"),
        (#"{"key":"agent:main:main","channel":"slack"}"#, nil),
        (#"{"key":"agent:main:dashboard:task","channel":"telegram"}"#, nil),
        (#"{"key":"custom:thread:room","channel":"  SLACK  "}"#, "Slack"),
        (#"{"key":"agent:main:slack:account:group:room"}"#, nil),
    ])
    func `linked channel labels survive preview off without misclassifying routing metadata`(
        wire: String, label: String?) throws
    {
        let facts = try self.facts(self.session(wire), showPreview: false)
        #expect(facts.channelLabel == label)
        #expect(facts.subtitle == nil)
    }

    @Test func `read terminal child glyphs keep status colors`() throws {
        for (status, tone) in [
            ("done", ChatSessionSidebarRowFacts.Tone.success),
            ("failed", .danger),
            ("timeout", .danger),
        ] {
            let row = try self.session("""
            {"key":"child","status":"\(status)","lastReadAt":2000,"endedAt":1000}
            """)
            #expect(self.facts(row, isChild: true).glyphTone == tone)
        }
    }

    @Test func `own queued subagent liveness does not invent unloaded descendant work`() throws {
        let row = try self.session(#"""
        {"key":"agent:main:subagent:queued","status":"queued",
         "hasActiveRun":true,"hasActiveSubagentRun":true}
        """#)
        #expect(self.facts(row).running && self.facts(row).queued)
    }

    @Test func `offline cached rows keep unread visible without claiming live work`() throws {
        let row = try self.session(#"""
        {"key":"agent:main:cached","status":"running","hasActiveRun":true,
         "hasActiveSubagentRun":true,"unread":true,"runtimeMs":1000}
        """#)
        let now = Date(timeIntervalSince1970: 20)
        let facts = ChatSessionSidebarRowFacts(
            node: ChatSessionSidebarModel.tree(from: [row])[0],
            isChild: false,
            attention: nil,
            showPreview: false,
            isConnected: false,
            preview: nil,
            now: now)
        #expect(!facts.running && facts.unread)
        #expect(ChatSessionSidebarRowFacts.runtimeText(
            row, sampledAt: now.addingTimeInterval(-10), now: now, isConnected: false) == "1s")
    }

    @Test(arguments: [false, true])
    func `collapsed parents retain descendant unread separately from leading activity`(running: Bool) throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data("""
        [{"key":"parent","hasActiveRun":\(running),"childSessions":["child"]},
         {"key":"child","unread":true}]
        """.utf8))
        let node = try #require(ChatSessionSidebarModel.tree(from: rows).first)
        let facts = ChatSessionSidebarRowFacts(
            node: node,
            isChild: false,
            attention: nil,
            showPreview: false,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.unreadDescendants)
        #expect(!facts.unread)
        #expect(facts.running == running)
    }

    @Test func `runtime sample identity ignores metadata but observes run progress and replacement`() throws {
        var row = try self.session(#"""
        {"key":"child","sessionId":"child-id","status":"running","hasActiveRun":true,
         "activeRunIds":["run-1"],"startedAt":1000,"runtimeMs":60000}
        """#)
        let sample = ChatSessionSidebarRowFacts.RuntimeSample(row)
        row.color = "blue"
        row.unread = false
        row.lastReadAt = 2000
        row.observerDigest = .init(runId: "run-1", revision: 1, updatedAt: 3000, headline: "Working", health: "working")
        #expect(ChatSessionSidebarRowFacts.RuntimeSample(row) == sample)
        row.runtimeMs = 70000
        #expect(ChatSessionSidebarRowFacts.RuntimeSample(row) != sample)
        row.runtimeMs = 60000
        row.activeRunIds = ["run-2"]
        #expect(ChatSessionSidebarRowFacts.RuntimeSample(row) != sample)
        row.activeRunIds = ["run-1"]
        row.hasActiveRun = nil
        #expect(ChatSessionSidebarRowFacts.RuntimeSample(row) == sample)
        row.hasActiveRun = false
        #expect(ChatSessionSidebarRowFacts.RuntimeSample(row) != sample)
    }

    @Test func `loaded idle descendants carry independent unloaded worker hints past an own queue`() throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(#"""
        [{"key":"parent","status":"queued","hasActiveRun":true,"childSessions":["child"]},
         {"key":"child","status":"done","hasActiveSubagentRun":true}]
        """#.utf8))
        let facts = try ChatSessionSidebarRowFacts(
            node: #require(ChatSessionSidebarModel.tree(from: rows).first),
            isChild: false,
            attention: nil,
            showPreview: false,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.running && !facts.queued)
    }

    @Test(arguments: ["failed", "timeout"])
    func `read child failures retain a parent summary without reopening attention`(status: String) throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data("""
        [{"key":"parent","childSessions":["child"]},
         {"key":"child","status":"\(status)","lastReadAt":2000,"endedAt":1000}]
        """.utf8))
        let facts = try ChatSessionSidebarRowFacts(
            node: #require(ChatSessionSidebarModel.tree(from: rows).first),
            isChild: false,
            attention: nil,
            showPreview: false,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
        #expect(facts.failedDescendants)
        #expect(facts.attentionLabel == nil && facts.glyph == nil && facts.subtitle == nil)
    }

    private func session(_ wire: String) throws -> OpenClawChatSessionEntry {
        try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(wire.utf8))
    }

    private func facts(
        _ session: OpenClawChatSessionEntry,
        isChild: Bool = false,
        attention: OpenClawChatAttentionSummary? = nil,
        showPreview: Bool = true) -> ChatSessionSidebarRowFacts
    {
        ChatSessionSidebarRowFacts(
            node: ChatSessionSidebarModel.tree(from: [session])[0],
            isChild: isChild,
            attention: attention,
            showPreview: showPreview,
            preview: nil,
            now: Date(timeIntervalSince1970: 2))
    }
}

#endif
