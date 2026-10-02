import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarFiltersModelTests {
    @Test func `owner filtering preserves visible parents descendant summaries`() throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(#"""
        [{"key":"parent","owner":{"actor":{"type":"human","id":"alice"}},"childSessions":["child"]},
         {"key":"child","owner":{"actor":{"type":"human","id":"bob"}},"unread":true,"status":"failed",
          "label":"Child work","lastRunError":"Needs repair","childSessions":["grandchild"]},
         {"key":"grandchild","owner":{"actor":{"type":"human","id":"alice"}}}]
        """#.utf8))
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "parent", query: "",
            viewOptions: .init(ownerFilter: "owner:alice"))
        let parent = try #require(sections.flatMap(\.nodes).first { $0.id == "parent" })
        #expect(parent.badges.hasUnread)
        #expect(parent.badges.failedCount == 1)
        #expect(ChatSessionSidebarModel.nodes(parent.children, matchingOwner: "alice").map(\.id) == ["grandchild"])
        #expect(ChatSessionSidebarModel.nodes([parent], matchingOwner: "bob").map(\.id) == ["child"])
        #if os(macOS)
        let facts = ChatSessionSidebarRowFacts(
            node: parent, isChild: false, attention: nil, showPreview: false, preview: nil,
            now: Date(timeIntervalSince1970: 1))
        #expect(facts.unreadDescendants && facts.failedDescendants)
        #expect(facts.attentionLabel == "Child session Child work failed: Needs repair")
        #endif
    }

    @Test func `sidebar category zones retain empty destinations and suppress archived descendants`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"plain","createdAt":2},
          {"key":"channel","kind":"group","category":"Research","childSessions":["release-child"]},
          {"key":"release-child","parentSessionKey":"channel"},
          {"key":"coding","execNode":"node-1"},
          {"key":"archived","archived":true,"childSessions":["hidden-child"]},
          {"key":"hidden-child","parentSessionKey":"archived"}
        ]}
        """#.utf8)).sessions
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "plain",
            groups: [.init(name: "Research", position: 0), .init(name: "Ops", position: 1)],
            query: "", viewOptions: .init(status: .all))
        #expect(sections.map(\.id) == ["group:Research", "group:Ops", "recent", "groups", "work"])
        #expect(sections.first(where: { $0.id == "work" })?.nodes.map(\.id) == ["coding"])
        #expect(sections.first?.nodes.first?.children.map(\.id) == ["release-child"])
        #expect(!sections.flatMap(\.nodes).flatMap { [$0.id] + $0.children.map(\.id) }.contains("hidden-child"))
    }

    @Test func `sidebar grouping uses canonical projects identities and flat mode without changing shared callers`() throws {
        let page = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"owners":[{"type":"human","id":"self","label":"Zed"},{"type":"human","id":"other","label":"Amy"}],
         "sessions":[
          {"key":"pin","pinned":true,"pinnedAt":10},
          {"key":"self","createdAt":1,"owner":{"actor":{"type":"human","id":"self","label":"Zed","identity":{"type":"profile","id":"self"}}}},
          {"key":"other","createdAt":2,"owner":{"actor":{"type":"human","id":"other","label":"Zoe","identity":{"type":"profile","id":"other"}}}},
          {"key":"agent","owner":{"actor":{"type":"agent","id":"self","label":"Agent","identity":{"type":"agent","id":"self"}}}},
          {"key":"repo","spawnedCwd":"/repo/.claude/worktrees/task/subdir/"},
          {"key":"remote","execNode":"worker","execCwd":"/node","worktree":{"repoRoot":"/wrong"}},
          {"key":"cloud","repository":{"url":"https://example.test/project.git"}},
          {"key":"group","kind":"group","category":"Research"}
        ]}
        """#.utf8))
        func sections(_ options: ChatSessionSidebarModel.ViewOptions?) -> [ChatSessionSidebarModel.Section] {
            ChatSessionSidebarModel.sections(
                sessions: page.sessions,
                currentSessionKey: "self",
                groups: [
                    .init(name: "Research", position: 0),
                    .init(name: "Ops", position: 1),
                ],
                query: "",
                viewOptions: options,
                owners: page.owners,
                selfOwnerID: "self")
        }
        let catalog = try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: Data(#"""
        {"groups":[{"name":"Research","position":0},{"name":"Ops","position":1}],
         "sectionOrder":["work","category:Research","groups","ungrouped","category:retired","work"]}
        """#.utf8))
        let ordered = ChatSessionSidebarModel.sections(
            sessions: page.sessions,
            currentSessionKey: "self",
            groups: catalog.groups,
            query: "",
            viewOptions: .init(),
            sectionOrder: catalog.sectionOrder ?? [])
        #expect(ordered.map(\.id) == ["pinned", "group:Ops", "work", "group:Research", "groups", "recent"])
        let singleOwner = ChatSessionSidebarModel.sections(
            sessions: page.sessions,
            currentSessionKey: "self",
            query: "",
            viewOptions: .init(sort: .people, grouping: .none),
            owners: Array((page.owners ?? []).prefix(1)))
        #expect(singleOwner.last?.nodes.prefix(2).map(\.id) == ["other", "self"])
        let person = sections(.init(grouping: .person))
        #expect(person.prefix(4).map(\.id) == [
            "pinned",
            "person:profile:self",
            "person:profile:other",
            "person:agent:self",
        ])
        #expect(person.first(where: { $0.id == "groups" })?.nodes.map(\.id) == ["group"])
        let project = sections(.init(grouping: .project))
        #expect(project.prefix(4).map(\.id) == [
            "pinned",
            "project:/node",
            "project:https://example.test/project",
            "project:/repo",
        ])
        #expect(sections(.init(grouping: .none)).map(\.id) == ["pinned", "recent"])
        #expect(sections(.init(grouping: .none)).last?.title == nil)
        #expect(sections(nil).map(\.id) == ["pinned", "group:Research", "recent"])
        let sorted = sections(.init(sort: .people, grouping: .none)).last?.nodes.map(\.id) ?? []
        #expect(try #require(sorted.firstIndex(of: "other")) < #require(sorted.firstIndex(of: "self")))
        for mode in [ChatSessionSidebarModel.EmptyGroups.filtering, .always, .never] {
            let filtered = sections(.init(emptyGroups: mode, ownerFilter: "owner:self"))
            #expect(filtered.contains { $0.id == "group:Ops" } == (mode == .never))
            #expect(filtered.flatMap(\.nodes).map(\.id).sorted() == ["agent", "self"])
        }
        #expect(sections(.init(emptyGroups: .filtering, status: .all)).contains { $0.id == "group:Ops" })
        #expect(sections(.init(status: .archived)).flatMap(\.nodes).isEmpty)
    }

    @Test(arguments: [
        ("acp:", true), ("agent:main:acp:thread", true), (":agent::main::acp::thread:", true),
        ("agent:main:acp:", false), ("agent: :acp:thread", false), ("ordinary:acp:thread", false),
    ])
    func `Coding classification follows web display key parsing`(key: String, coding: Bool) {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [self.entry(key: "ordinary"), self.entry(key: key)], currentSessionKey: "ordinary",
            query: "", viewOptions: .init())
        #expect((sections.first(where: { $0.id == "work" })?.nodes.contains { $0.id == key } ?? false) == coding)
    }

    @Test func `Person headers retain the first sorted row owner projection`() throws {
        let rows = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(#"""
        [{"key":"newer","createdAt":2,"owner":{"actor":{"type":"human","id":"person","label":"Current name","identity":{"type":"profile","id":"person"}}}},
         {"key":"older","createdAt":1,"owner":{"actor":{"type":"human","id":"person","label":"Old name","identity":{"type":"profile","id":"person"}}}}]
        """#.utf8))
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "newer",
            query: "",
            viewOptions: .init(grouping: .person))
        #expect(sections.first?.title == "Current name")
        #expect(sections.first?.nodes.map(\.id) == ["newer", "older"])
    }

    private func entry(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil)
    }
}
