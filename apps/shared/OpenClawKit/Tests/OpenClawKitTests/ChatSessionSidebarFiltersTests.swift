#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarFiltersTests {
    private let alice = #"{"type":"human","id":"alice","label":"Alice","identity":{"type":"profile","id":"alice"}}"#
    private let bea = #"{"type":"human","id":"bea","label":"Bea","identity":{"type":"profile","id":"bea"}}"#

    private func roster(_ wire: String) throws -> OpenClawChatSessionsListResponse {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(wire.utf8))
    }

    private func ownership() throws -> ChatSidebarOwnership {
        let page = try self.roster(#"{"owners":[\#(self.alice),\#(self.bea)],"sessions":[]}"#)
        return ChatSidebarOwnership(facet: page.owners, selfOwner: page.owners?.first, rows: [])
    }

    private func row(_ fields: String = "") throws -> OpenClawChatSessionEntry {
        try #require(self
            .roster(
                #"{"sessions":[{"key":"thread","owner":{"actor":\#(self.alice)},"archivedBy":\#(self.bea)\#(fields)}]}"#)
            .sessions.first)
    }

    @Test func `owner facets remain complete across filtered pages and unresolved refreshes`() throws {
        let page = try self.roster(#"""
        {"owners":[\#(self.bea)],"sessions":[
          {"key":"loaded","owner":{"actor":{"type":"human","id":"row-only","label":"Not a facet"}}}
        ]}
        """#)
        let selfOwner = try self.ownership().owners.first
        let complete = ChatSidebarOwnership(facet: page.owners, selfOwner: selfOwner, rows: page.sessions)
        #expect(complete.owners.compactMap(\.id) == ["alice", "bea"])
        #expect(complete.showsFilters && complete.showsAvatars)
        #expect(!complete.peopleAvailable)
        #expect(complete.activeOwnerID("bea") == "bea")
        #expect(complete.activeOwnerID("row-only") == nil)

        let unresolved = ChatSidebarOwnership(facet: nil, selfOwner: selfOwner, rows: page.sessions)
        #expect(unresolved.owners.compactMap(\.id) == ["alice"])
        #expect(!unresolved.showsFilters && !unresolved.showsAvatars)
        #expect(unresolved.peopleAvailable)
        #expect(unresolved.activeOwnerID("bea") == "bea")
        let empty = ChatSidebarOwnership(facet: [], selfOwner: selfOwner, rows: page.sessions)
        #expect(empty.activeOwnerID("bea") == nil)
        #expect(empty.activeOwnerID("alice") == "alice")
        #expect(!empty.peopleAvailable)

        let collision = try self.roster(#"""
        {"owners":[{"type":"agent","id":"alice","identity":{"type":"agent","id":"alice"}}],"sessions":[]}
        """#)
        let agent = ChatSidebarOwnership(facet: collision.owners, selfOwner: selfOwner, rows: [])
        #expect(agent.owners.count == 1)
        #expect(agent.owners.first?.type == "agent")
        #expect(!agent.showsAvatars)
        #expect(try self.ownership().peopleAvailable)
    }

    @Test(arguments: [
        (#"{"type":"profile","id":"alice"}"#, 1, false, false),
        (#"{"type":"agent","id":"alice"}"#, 1, true, false),
        (#"{"type":"profile","id":"bea"}"#, 1, true, true),
        (
            #"{"type":"observation","pluginId":"slack","accountId":"work","senderKind":"human","id":"bea"}"#,
            1,
            true,
            true),
        (#"{"type":"legacy","actorType":"human","source":"import","id":"bea"}"#, 1, true, true),
        (#"{"type":"remote","pluginId":"slack","domain":"work","idKind":"user","id":"bea"}"#, 1, true, false),
        (#"{"type":"profile","id":"alice"}"#, 2, true, false),
    ])
    func `participant evidence gates avatars separately from filters and People capability`(
        identity: String, count: Int, filters: Bool, avatars: Bool) throws
    {
        let page = try self.roster(#"""
        {"owners":[\#(self.alice)],"sessions":[{"key":"shared",
          "participants":[{"identity":\#(identity)}],"participantCount":\#(count)}]}
        """#)
        let ownership = ChatSidebarOwnership(facet: page.owners, selfOwner: nil, rows: page.sessions)
        #expect(ownership.showsFilters == filters)
        #expect(ownership.showsAvatars == avatars)
        #expect(!ownership.peopleAvailable)
    }

    @Test func `filter count excludes display choices and reset preserves capability hidden Person`() {
        var options = ChatSessionSidebarModel.ViewOptions(
            sort: .updated, showAutomation: true, showSystem: true,
            grouping: .project, emptyGroups: .never, showMessagePreview: true)
        #expect(options.filterCount == 0)
        #expect(options.isChanged(peopleAvailable: true))
        for owner in ["", "owner:alice", "involving-me"] {
            for status in [OpenClawChatSidebarStatus.active, .archived, .all] {
                options.ownerFilter = owner
                options.status = status
                #expect(options.filterCount == (owner.isEmpty ? 0 : 1) + (status == .active ? 0 : 1))
                #expect(options.involvingMe == (owner == "involving-me"))
                #expect(options.ownerID == (owner == "owner:alice" ? "alice" : nil))
            }
        }
        options.reset(peopleAvailable: true)
        #expect(options == .init())
        #expect(!options.isChanged(peopleAvailable: true))

        options.grouping = .person
        #expect(options.effectiveGrouping(peopleAvailable: false) == .category)
        #expect(!options.isChanged(peopleAvailable: false))
        options.ownerFilter = "involving-me"
        options.reset(peopleAvailable: false)
        #expect(options.grouping == .person)
        #expect(options.filterCount == 0)
        #expect(options.effectiveGrouping(peopleAvailable: true) == .person)
        options.reset(peopleAvailable: true)
        #expect(options.grouping == .category)
    }

    @Test(arguments: [
        ("ordinary", true), ("self owner filter", false), ("involving me", false),
        ("shared self filter", true), ("Person idle", false), ("Person viewing", true),
        ("Person pinned", true), ("child", false), ("decorated", false), ("single human", false),
    ])
    func `row attribution follows self filters Person headers and leading slot ownership`(
        scenario: String, visible: Bool) throws
    {
        var row = try self.row()
        var options = ChatSessionSidebarModel.ViewOptions()
        var ownership = try self.ownership()
        if scenario == "single human" {
            ownership = ChatSidebarOwnership(facet: [ownership.owners[0]], selfOwner: nil, rows: [row])
        }
        if scenario.contains("self") { options.ownerFilter = "owner:alice" }
        if scenario == "involving me" { options.ownerFilter = "involving-me" }
        if scenario == "shared self filter" { row.participantCount = 2 }
        if scenario.hasPrefix("Person") { options.grouping = .person }
        if scenario == "Person pinned" { row.pinned = true }
        let attribution = ownership.attribution(
            for: row, options: options, isChild: scenario == "child", decorated: scenario == "decorated",
            viewingProfileIDs: scenario == "Person viewing" ? ["alice"] : [])
        #expect((attribution != nil) == visible)
        if visible {
            #expect(attribution?.actor.id == "alice")
            #expect(attribution?.viewing == (scenario == "Person viewing"))
            #expect(attribution?.label == "Created by Alice")
        }
    }

    @Test func `archive mode owns attribution while All retains owner and participant faces deduplicate viewers`() throws {
        let ownership = try self.ownership()
        var row = try self
            .row(
                #", "archived":true,"participants":[{"identity":{"type":"profile","id":"bea"},"label":"Bea"}],"participantCount":1"#)
        func attribution(_ options: ChatSessionSidebarModel.ViewOptions) throws -> ChatSidebarOwnership.Attribution {
            try #require(ownership.attribution(
                for: row, options: options, isChild: false, decorated: false, viewingProfileIDs: ["bea"]))
        }
        let archived = try attribution(.init(grouping: .person, status: .archived, ownerFilter: "owner:bea"))
        #expect(archived.actor.id == "bea")
        #expect(archived.label == "Archived by Bea")
        #expect(archived.viewing == true)
        let all = try attribution(.init(status: .all))
        #expect(all.actor.id == "alice")
        #expect(all.label == "Created by Alice")
        #expect(all.participantCount == 1)
        #expect(all.renderedProfileIDs == ["alice", "bea"])
        row.participantCount = 3
        let overflow = try attribution(.init(status: .all))
        #expect(overflow.participantCount == 3)
        #expect(overflow.renderedProfileIDs == ["alice"])
        row = try #require(self.roster(#"""
        {"sessions":[{"key":"assigned","owner":{"actor":\#(self.alice),"assignedAt":100}}]}
        """#).sessions.first)
        #expect(try attribution(.init()).label == "Owned by Alice")
    }
}
#endif
