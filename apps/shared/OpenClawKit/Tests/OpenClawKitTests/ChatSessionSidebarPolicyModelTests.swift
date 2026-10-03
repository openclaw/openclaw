import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarPolicyModelTests {
    @Test func `all agent Pages restrict roots to selectable agents without discarding visible child trees`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:pin","pinned":true,"childSessions":["agent:ops:child"]},
          {"key":"agent:ops:child","parentSessionKey":"agent:main:pin"},
          {"key":"agent:system:pin","pinned":true},
          {"key":"agent:retired:pin","pinned":true},
          {"key":"agent:system:parent","childSessions":["agent:ops:thread"]},
          {"key":"agent:ops:thread","parentSessionKey":"agent:system:parent"}
        ]}
        """#.utf8)).sessions
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "agent:ops:thread",
            query: "",
            viewOptions: .init(grouping: .none),
            allowedAgentIDs: ["main", "ops"])
        #expect(sections.first { $0.id == "pinned" }?.nodes.map(\.id) == ["agent:main:pin"])
        #expect(sections.first { $0.id == "pinned" }?.nodes.first?.children.map(\.id) == ["agent:ops:child"])
        #expect(sections.filter { $0.id != "pinned" }.flatMap(\.nodes).map(\.id) == ["agent:ops:thread"])
    }

    @Test func `all agent Pages retain pinned trees while every Home promotes its conversations`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:main","childSessions":["agent:main:home-child"]},
          {"key":"agent:other:main","childSessions":["agent:other:home-child"]},
          {"key":"agent:main:home-child","spawnedBy":"agent:main:main"},
          {"key":"agent:other:home-child","spawnedBy":"agent:other:main"},
          {"key":"agent:main:pin","pinned":true,"pinnedAt":1,"category":"Research"},
          {"key":"agent:other:pin","pinned":true,"pinnedAt":2,"childSessions":["agent:main:pin-child"]},
          {"key":"agent:main:pin-child","parentSessionKey":"agent:other:pin"},
          {"key":"agent:main:task","category":"Ops"},
          {"key":"agent:other:task","category":"Research"}
        ]}
        """#.utf8)).sessions
        func sections(_ agentID: String?) -> [ChatSessionSidebarModel.Section] {
            ChatSessionSidebarModel.sections(
                sessions: rows,
                currentSessionKey: "agent:main:task",
                mainSessionKey: "agent:main:main",
                activeAgentID: agentID,
                excludesMainSession: true,
                query: "",
                viewOptions: .init(grouping: .none))
        }
        let all = sections(nil)
        let pages = try #require(all.first { $0.id == "pinned" })
        #expect(Set(pages.nodes.map(\.id)) == ["agent:main:pin", "agent:other:pin"])
        #expect(pages.nodes.first { $0.id == "agent:other:pin" }?.children.map(\.id) == ["agent:main:pin-child"])
        #expect(Set(all.filter { $0.id != "pinned" }.flatMap(\.nodes).map(\.id)) == [
            "agent:main:home-child", "agent:other:home-child", "agent:main:task", "agent:other:task",
        ])
        #expect(sections("main").first { $0.id == "pinned" }?.nodes.map(\.id) == ["agent:main:pin"])
        let foreignPin = try #require(pages.nodes.first { $0.id == "agent:other:pin" })
        let attention = ChatSessionSidebarModel.attentionSummary(
            requests: [.init(
                id: "child-question",
                kind: .question,
                sessionKey: "agent:main:pin-child",
                agentID: "main",
                createdAtMs: 1,
                expiresAtMs: 1000,
                preview: "Review child")],
            sessions: foreignPin.previewSessions,
            mainSessionKey: "agent:other:main",
            activeAgentID: "other",
            sessionRoutingContract: nil,
            now: Date(timeIntervalSince1970: 0))
        #expect(attention?.oldest.id == "child-question")
    }

    @Test func `owner pruning retains workspace conflicts for compact child visibility`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:parent",
           "childSessions":["agent:main:a","agent:main:b","agent:main:c","agent:main:d","agent:main:review"],
           "owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:a","owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:b","owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:c","owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:d","owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:review","childSessions":["agent:main:conflict"],
           "owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:conflict","owner":{"actor":{"type":"human","id":"other"}},
           "placement":{"state":"active","generation":1,"createdAtMs":1,"updatedAtMs":1,"stateChangedAtMs":1,
             "workspaceResultConflict":{"totalCount":1,"paths":[]}}}
        ]}
        """#.utf8)).sessions
        let root = try #require(ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "agent:main:parent",
            query: "",
            viewOptions: .init(ownerFilter: "owner:self")).flatMap(\.nodes).first)
        #expect(root.children.last?.children.isEmpty == true)
        #expect(root.visibleChildren(selectedKey: root.id, fullyShown: false, now: Date()) { _ in nil }
            .map(\.id) == ["agent:main:a", "agent:main:b", "agent:main:c", "agent:main:d", "agent:main:review"])
    }

    @Test(arguments: ["agent:main:cron:job", "agent:main:system-parent"])
    func `selected ancestry escapes ordinary discovery toggles`(parentKey: String) throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"agent:main:child","spawnedBy":"\#(parentKey)","parentSessionKey":"\#(parentKey)"}]}
        """#.utf8)).sessions
        let lineage = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"\#(parentKey)","createdActor":{"type":"system"},"childSessions":["agent:main:child"]}]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "agent:main:child",
            query: "",
            viewOptions: .init(),
            supplementalSessions: lineage,
            lineageRootKey: parentKey).flatMap(\.nodes)
        #expect(roots.map(\.id) == [parentKey])
        #expect(roots.first?.children.map(\.id) == ["agent:main:child"])
    }

    @Test(arguments: ["self", "other"])
    func `owner filtering promotes matching descendants through excluded parents`(ownerID: String) throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:parent","childSessions":["agent:main:subagent:run"],
           "owner":{"actor":{"type":"human","id":"other"}}},
          {"key":"agent:main:subagent:run","spawnedBy":"agent:main:parent","childSessions":["agent:main:child"]},
          {"key":"agent:main:child","parentSessionKey":"agent:main:subagent:run",
           "childSessions":["agent:main:branch"],"owner":{"actor":{"type":"human","id":"self"}}},
          {"key":"agent:main:branch","parentSessionKey":"agent:main:child",
           "childSessions":["agent:main:leaf"],"owner":{"actor":{"type":"human","id":"other"}}},
          {"key":"agent:main:leaf","parentSessionKey":"agent:main:branch",
           "owner":{"actor":{"type":"human","id":"self"}}}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "agent:main:parent",
            query: "",
            viewOptions: .init(ownerFilter: "owner:\(ownerID)")).flatMap(\.nodes)
        #expect(roots.map(\.id) == [ownerID == "self" ? "agent:main:child" : "agent:main:parent"])
        #expect(roots.first?.children.map(\.id) == [ownerID == "self" ? "agent:main:leaf" : "agent:main:branch"])
        #expect(roots.first?.children.first?.children.isEmpty == true)
    }

    @Test(arguments: [OpenClawChatSidebarStatus.active, .all])
    func `active child membership does not hide archived descendants from All`(
        status: OpenClawChatSidebarStatus) throws
    {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","childSessions":["active","archived-listed"]},
          {"key":"active","parentSessionKey":"parent"},
          {"key":"archived-listed","archived":true,"spawnedBy":"parent"},
          {"key":"archived-backref","archived":true,"parentSessionKey":"parent"}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "parent",
            query: "",
            viewOptions: .init(status: status),
            childMembership: ["parent": ["active"]]).flatMap(\.nodes)
        #expect(roots.map(\.id) == ["parent"])
        #expect(roots.first?.children.map(\.id) ==
            (status == .all ? ["active", "archived-listed", "archived-backref"] : ["active"]))
    }

    @Test(arguments: [OpenClawChatSidebarStatus.active, .snoozed, .all])
    func `descendants honor the current snooze filter`(status: OpenClawChatSidebarStatus) throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","childSessions":["awake","sleeping","unknown"],"snoozedUntil":4102444800000},
          {"key":"awake","parentSessionKey":"parent"},
          {"key":"sleeping","parentSessionKey":"parent","snoozedUntil":4102444800000}
        ]}
        """#.utf8)).sessions
        let tree = try #require(ChatSessionSidebarModel.sidebarTree(
            roots: [rows[0]],
            rows: rows,
            home: (keys: [], excluded: false),
            selectedKey: "parent",
            lineageRootKey: nil,
            membership: [:],
            options: .init(status: status)).first)
        #expect(tree.children.map(\.id) == (status == .all ? ["awake", "sleeping"] :
                (status == .snoozed ? ["sleeping"] : ["awake"])))
    }

    @Test(arguments: [OpenClawChatSidebarStatus.all, .archived], [false, true])
    func `archived parents hide ordinary children but retain curated and selected roots`(
        status: OpenClawChatSidebarStatus,
        selectedChild: Bool) throws
    {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","archived":true,"childSessions":["child","curated"]},
          {"key":"child","parentSessionKey":"parent","archived":true},
          {"key":"curated","parentSessionKey":"parent","archived":true,"category":"Research"}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: selectedChild ? "child" : "parent",
            query: "",
            viewOptions: .init(status: status)).flatMap(\.nodes)
        #expect(Set(roots.map(\.id)) == (selectedChild ? ["parent", "child", "curated"] : ["parent", "curated"]))
        #expect(roots.flatMap(\.children).isEmpty)
    }

    @Test(arguments: ["parent", "subagent:worker"])
    func `persistent roots retain their fallback beneath archived run ancestry`(archivedKey: String) throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","childSessions":["subagent:worker"],"archived":\#(archivedKey == "parent")},
          {"key":"subagent:worker","parentSessionKey":"parent","childSessions":["child"],
           "archived":\#(archivedKey == "subagent:worker")},
          {"key":"child","parentSessionKey":"subagent:worker"}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "parent",
            query: "",
            viewOptions: .init(status: .all)).flatMap(\.nodes)
        #expect(Set(roots.map(\.id)) == ["parent", "child"])
        #expect(roots.flatMap(\.children).isEmpty)
    }

    @Test func `known queued descendants account for the subagent flag without adding running work`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","hasActiveSubagentRun":true,"childSessions":["subagent:wrapper"]},
          {"key":"subagent:wrapper","hasActiveSubagentRun":true,"childSessions":["subagent:queued"]},
          {"key":"subagent:queued","hasActiveRun":true,"status":"queued"},
          {"key":"unloaded","hasActiveSubagentRun":true}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "", viewOptions: .init()).flatMap(\.nodes)
        let parent = try #require(roots.first { $0.id == "parent" })
        #expect(parent.badges.queuedCount == 1)
        #expect(parent.badges.runningCount == 0)
        let unloaded = try #require(roots.first { $0.id == "unloaded" })
        #expect(unloaded.badges.queuedCount == 0)
        #expect(unloaded.badges.runningCount == 1)
    }

    @Test func `folded run counts honor explicit inactivity terminal status and archives`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","childSessions":["subagent:inactive","subagent:finished","subagent:archived"]},
          {"key":"subagent:inactive","status":"queued","hasActiveRun":false},
          {"key":"subagent:finished","status":"done","hasActiveRun":true},
          {"key":"subagent:archived","status":"queued","hasActiveRun":true,"archived":true}
        ]}
        """#.utf8)).sessions
        let root = try #require(ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "", viewOptions: .init(status: .all))
            .flatMap(\.nodes).first)
        #expect(root.badges.queuedCount == 0)
        #expect(root.badges.runningCount == 0)
    }

    @Test func `local sidebar search keeps matching persistent children without their parents`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"child","label":"Research plan","spawnedBy":"missing-parent"}]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "other", query: "Research", viewOptions: .init()).flatMap(\.nodes)
        #expect(roots.map(\.id) == ["child"])
        #expect(roots.first?.children.isEmpty == true)
    }

    @Test func `hydrated descriptors replace selected placeholders without duplicate children`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"parent","childSessions":["agent:main:subagent:run"]}]}
        """#.utf8)).sessions
        let extra = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:subagent:run","parentSessionKey":"parent","childSessions":["selected"]},
          {"key":"selected","label":"Release plan","sessionId":"selected-id"}
        ]}
        """#.utf8)).sessions
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "selected", query: "", viewOptions: .init(), supplementalSessions: extra)
        let roots = sections.flatMap(\.nodes)
        #expect(roots.map(\.id) == ["parent"])
        #expect(roots.first?.children.first?.session.label == "Release plan")
        #expect(roots.first?.children.first?.session.sessionId == "selected-id")
    }

    @Test func `child reveal retains selected and folded failure branches but caps quiet rows`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent",
           "childSessions":["a","b","c","d","quiet","read-leaf","branch","selected","working","unread","conflict"]},
          {"key":"a"},{"key":"b"},{"key":"c"},{"key":"d"},{"key":"quiet"},
          {"key":"read-leaf","status":"failed","lastReadAt":20,"endedAt":10},
          {"key":"branch","childSessions":["subagent:failed"]},
          {"key":"subagent:failed","status":"failed","lastReadAt":20,"endedAt":10},
          {"key":"selected"},{"key":"working","hasActiveRun":true},{"key":"unread","unread":true},
          {"key":"conflict","placement":{"state":"active","generation":1,"createdAtMs":1,"updatedAtMs":1,
           "stateChangedAtMs":1,"workspaceResultConflict":{"totalCount":1,"paths":[]}}}
        ]}
        """#.utf8)).sessions
        let root = try #require(ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "", viewOptions: .init()).flatMap(\.nodes).first)
        let visible = root.visibleChildren(selectedKey: "selected", fullyShown: false, now: Date()) { _ in nil }
        #expect(visible.map(\.id) == ["a", "b", "c", "d", "branch", "selected", "working", "unread", "conflict"])
        #expect(root.visibleChildren(selectedKey: "parent", fullyShown: true, now: Date()) { _ in nil }.count == 11)
    }

    @Test func `Home projects hidden run load parents and promotes only persistent descendants`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:main:main","childSessions":["agent:main:subagent:run"]},
          {"key":"agent:main:subagent:run","spawnedBy":"agent:main:main","childSessions":["agent:main:child"]},
          {"key":"agent:main:child","parentSessionKey":"agent:main:subagent:run","label":"Research"}
        ]}
        """#.utf8)).sessions
        let home = try #require(ChatSessionSidebarModel.sidebarTree(
            roots: [rows[0]],
            rows: rows,
            home: (keys: [rows[0].key], excluded: false),
            selectedKey: rows[0].key,
            lineageRootKey: nil,
            membership: [:],
            options: .init()).first)
        #expect(home.loadParentKeys == ["agent:main:main", "agent:main:subagent:run"])
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: rows[0].key,
            mainSessionKey: rows[0].key,
            excludesMainSession: true,
            query: "",
            viewOptions: .init()).flatMap(\.nodes)
        #expect(roots.map(\.id) == ["agent:main:child"])
    }

    @Test func `supplemental global Home promotes its persistent child without becoming a row`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"agent:ops:release-plan","agentId":"ops","sessionId":"release-plan",
           "label":"Release plan","parentSessionKey":"global","spawnedBy":"global"}
        ]}
        """#.utf8)).sessions
        let extra = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"global","agentId":"ops","kind":"global","sessionId":"ops-home",
           "childSessions":["agent:ops:release-plan"]}
        ]}
        """#.utf8)).sessions
        let roots = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "global",
            mainSessionKey: "agent:ops:main",
            activeAgentID: "ops",
            excludesMainSession: true,
            query: "",
            sessionRoutingContract: "global|main|main",
            viewOptions: .init(),
            supplementalSessions: extra,
            lineageRootKey: "global").flatMap(\.nodes)
        #expect(roots.map(\.id) == ["agent:ops:release-plan"])
        #expect(roots.first?.session.label == "Release plan")
    }

    @Test func `sidebar heartbeat classification precedes creation provenance`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"ordinary"},
          {"key":"unnamed","classification":"heartbeat","createdActor":{"type":"human"}},
          {"key":"named","classification":"heartbeat","label":"Release check","createdActor":{"type":"system"}},
          {"key":"subject","classification":"heartbeat","subject":"Ops","createdActor":{"type":"system"}},
          {"key":"display","classification":"heartbeat","displayName":"Research","createdActor":{"type":"system"}},
          {"key":"global","kind":"global"}, {"key":"unknown","kind":"unknown"}
        ]}
        """#.utf8)).sessions
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "ordinary", query: "", viewOptions: .init())
        #expect(Set(sections.flatMap(\.nodes).map(\.id)) == ["ordinary", "named", "subject", "display"])
    }

    @Test func `sidebar folds categorized runs but releases categorized persistent children`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"parent","pinned":true,"childSessions":["agent:main:subagent:run","curated","pinned-child"]},
          {"key":"agent:main:subagent:run","category":"Ops","parentSessionKey":"parent",
           "status":"running","childSessions":["persistent"]},
          {"key":"persistent","spawnedBy":"agent:main:subagent:run","parentSessionKey":"agent:main:subagent:run"},
          {"key":"curated","spawnedBy":"parent","parentSessionKey":"parent","category":"Research"},
          {"key":"pinned-child","spawnedBy":"parent","pinned":true}
        ]}
        """#.utf8)).sessions
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "", viewOptions: .init(grouping: .none))
        let roots = sections.flatMap(\.nodes)
        #expect(Set(roots.map(\.id)) == ["parent", "curated", "pinned-child"])
        #expect(sections.first { $0.id == "pinned" }?.nodes.map(\.id) == ["parent", "pinned-child"])
        let parent = try #require(roots.first { $0.id == "parent" })
        #expect(parent.children.map(\.id) == ["persistent"])
        #expect(parent.badges.runningCount == 1)
    }
}
