import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct RootSidebarMenuParityTests {
    private enum FetchFailure: Error { case unavailable }
    private let now = Date(timeIntervalSince1970: 100)

    private func response(_ json: String) throws -> OpenClawChatSessionsListResponse {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(json.utf8))
    }

    private func rows(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try self.response("{\"sessions\":\(json)}").sessions
    }

    private func keys(_ sections: [ChatSessionSidebarModel.Section]) -> [String] {
        func flatten(_ nodes: [ChatSessionSidebarModel.Node]) -> [String] {
            nodes.flatMap { [$0.session.key] + flatten($0.children) }
        }
        return sections.flatMap { flatten($0.nodes) }
    }

    private func project(
        _ rows: [OpenClawChatSessionEntry],
        options: ChatSessionSidebarModel.ViewOptions? = .init(),
        selected: String = "",
        groups: [OpenClawChatSessionGroup] = [],
        owners: [OpenClawChatSessionEntry.CreatedActor]? = nil) -> [ChatSessionSidebarModel.Section]
    {
        RootSidebarModel.sections(
            sessions: rows, query: "", currentSessionKey: selected,
            mainSessionKey: "agent:main:main", activeAgentID: "main", groups: groups,
            now: self.now, viewOptions: options, owners: owners)
    }

    @Test func `fresh and invalid preferences preserve iOS roster defaults`() throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let fresh = RootSidebarPreferences.load(defaults: defaults)
        #expect(fresh == .init(sort: .updated, showAutomation: true, showSystem: true))
        #expect(fresh.status == .active)
        #expect(fresh.sort == .updated)
        #expect(fresh.showAutomation)
        #expect(fresh.showSystem)
        #expect(fresh.grouping == .category)
        #expect(fresh.emptyGroups == .filtering)
        for key in ["sort", "grouping", "emptyGroups", "status"] {
            defaults.set("removed-option", forKey: "openclaw.ios.sidebar." + key)
        }
        #expect(RootSidebarPreferences.load(defaults: defaults) == fresh)
    }

    @Test func `saved grouping ordering filters and preview round trip independently of selected agent`() throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        var options = ChatSessionSidebarModel.ViewOptions(
            sort: .people, showAutomation: true, showSystem: true, grouping: .project,
            emptyGroups: .never, status: .all, ownerFilter: "owner:alice", showMessagePreview: true,
            selectedAgentID: "temporary-agent")
        RootSidebarPreferences.save(options, defaults: defaults)
        options.selectedAgentID = nil
        #expect(RootSidebarPreferences.load(defaults: defaults) == options)
        options.status = .snoozed
        options.ownerFilter = "involving-me"
        options.grouping = .person
        options.sort = .created
        options.showAutomation = false
        options.showSystem = false
        RootSidebarPreferences.save(options, defaults: defaults)
        #expect(RootSidebarPreferences.load(defaults: defaults) == options)
    }

    @Test func `reset removes visible changes but retains a temporarily unavailable person grouping`() {
        var options = ChatSessionSidebarModel.ViewOptions(
            sort: .updated, showAutomation: true, showSystem: true, grouping: .person,
            emptyGroups: .never, status: .archived, ownerFilter: "involving-me", showMessagePreview: true)
        #expect(options.filterCount == 2)
        options.reset(peopleAvailable: false)
        #expect(options == .init(grouping: .person))
        #expect(!options.isChanged(peopleAvailable: false))
        #expect(options.isChanged(peopleAvailable: true))
        options.reset(peopleAvailable: true)
        #expect(options == .init())
    }

    @Test func `status choices partition active snoozed and archived rows without resurrecting selection`() throws {
        let rows = try self.rows(#"""
        [
          {"key":"agent:main:main","sessionId":"home"},
          {"key":"agent:main:active","sessionId":"active"},
          {"key":"agent:main:expired","sessionId":"expired","snoozedUntil":99000},
          {"key":"agent:main:snoozed","sessionId":"snoozed","snoozedUntil":101000},
          {"key":"agent:main:archived","sessionId":"archived","archived":true,"snoozedUntil":102000},
          {"key":"agent:other:foreign","sessionId":"foreign"}
        ]
        """#)
        #expect(Set(self.keys(self.project(rows, selected: "agent:main:snoozed"))) == [
            "agent:main:active", "agent:main:expired",
        ])
        #expect(self.keys(self.project(rows, options: .init(status: .snoozed), selected: "missing")) == [
            "agent:main:snoozed",
        ])
        #expect(self.keys(self.project(rows, options: .init(status: .archived), selected: "missing")) == [
            "agent:main:archived",
        ])
        #expect(Set(self.keys(self.project(rows, options: .init(status: .all)))) == [
            "agent:main:active", "agent:main:expired", "agent:main:snoozed", "agent:main:archived",
        ])
    }

    @Test func `legacy projection keeps main in Home and snoozed selection out of sessions`() throws {
        let rows = try self.rows(#"""
        [
          {"key":"agent:main:main","updatedAt":300},
          {"key":"agent:main:recent","updatedAt":200},
          {"key":"agent:main:older","updatedAt":100},
          {"key":"agent:main:snoozed","updatedAt":400,"snoozedUntil":101000}
        ]
        """#)
        #expect(self.keys(self.project(rows, options: nil, selected: "agent:main:snoozed")) == [
            "agent:main:recent", "agent:main:older",
        ])
    }

    @Test func `owner filter promotes matching child and does not synthesize an unrelated selected row`() throws {
        let rows = try self.rows(#"""
        [
          {"key":"agent:main:parent","childSessions":["agent:main:child"],
           "owner":{"actor":{"type":"human","id":"bea","label":"Bea"}}},
          {"key":"agent:main:child","parentSessionKey":"agent:main:parent",
           "owner":{"actor":{"type":"human","id":"alice","label":"Alice"}}},
          {"key":"agent:main:other","owner":{"actor":{"type":"human","id":"bea","label":"Bea"}}}
        ]
        """#)
        let sections = self.project(rows, options: .init(ownerFilter: "owner:alice"), selected: "agent:main:missing")
        #expect(self.keys(sections) == ["agent:main:child"])
        #expect(sections.flatMap(\.nodes).first?.session.key == "agent:main:child")
    }

    @Test func `created and updated orders remain separate and named group order uses catalog positions`() throws {
        let rows = try self.rows(#"""
        [
          {"key":"agent:main:old","createdAt":100,"updatedAt":900,"category":"Later"},
          {"key":"agent:main:new","createdAt":200,"updatedAt":300,"category":"Later"},
          {"key":"agent:main:first","createdAt":1,"category":"First"}
        ]
        """#)
        let groups = [
            OpenClawChatSessionGroup(name: "Later", position: 2),
            OpenClawChatSessionGroup(name: "First", position: 1),
        ]
        let created = self.project(rows, groups: groups)
        #expect(created.filter { $0.id.hasPrefix("group:") }.map(\.id) == ["group:First", "group:Later"])
        #expect(created.first { $0.id == "group:Later" }?.nodes.map(\.session.key) == [
            "agent:main:new", "agent:main:old",
        ])
        let updated = self.project(rows, options: .init(sort: .updated), groups: groups)
        #expect(updated.first { $0.id == "group:Later" }?.nodes.map(\.session.key) == [
            "agent:main:old", "agent:main:new",
        ])
        let ungrouped = self.project(rows, options: .init(grouping: .none, emptyGroups: .always), groups: groups)
        #expect(ungrouped.map(\.id) == ["recent"])
        #expect(self.keys(ungrouped) == ["agent:main:new", "agent:main:old", "agent:main:first"])
    }

    @Test func `complete roster retains owner and self facets when later pages omit them`() async throws {
        let first = try self.response(#"""
        {"sessions":[{"key":"agent:main:a"}],"totalCount":2,"hasMore":true,"nextOffset":1,
         "owners":[{"type":"human","id":"alice","label":"Alice"}],"involvingProfileId":"alice"}
        """#)
        let last = try self.response(#"{"sessions":[{"key":"agent:main:b"}],"totalCount":2,"hasMore":false}"#)
        var offsets: [Int] = []
        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            offsets.append(offset)
            return offset == 0 ? first : last
        }
        #expect(offsets == [0, 1])
        #expect(snapshot.isComplete)
        #expect(snapshot.owners?.map(\.id) == ["alice"])
        #expect(snapshot.involvingProfileID == "alice")
    }

    @Test func `partial roster failure retains its valid facets and marks the roster incomplete`() async throws {
        let first = try self.response(#"""
        {"sessions":[{"key":"agent:main:a"}],"totalCount":2,"hasMore":true,"nextOffset":1,
         "owners":[{"type":"human","id":"alice","label":"Alice"}],"involvingProfileId":"alice"}
        """#)
        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            if offset != 0 { throw FetchFailure.unavailable }
            return first
        }
        #expect(!snapshot.isComplete)
        #expect(snapshot.sessions.map(\.key) == ["agent:main:a"])
        #expect(snapshot.owners?.map(\.id) == ["alice"])
        #expect(snapshot.involvingProfileID == "alice")
    }

    @Test func `all-agent roster retains identical bare keys owned by different agents`() async throws {
        let first = try self.response(#"""
        {"sessions":[{"key":"shared","agentId":"main","label":"Main"}],
         "totalCount":2,"hasMore":true,"nextOffset":1}
        """#)
        let last = try self.response(#"""
        {"sessions":[{"key":"shared","agentId":"other","label":"Other"}],"totalCount":2,"hasMore":false}
        """#)
        let snapshot = try await ChatSessionRosterSnapshot.collect { $0 == 0 ? first : last }
        #expect(snapshot.isComplete)
        #expect(snapshot.sessions.map(\.agentId) == ["main", "other"])
        #expect(snapshot.sessions.map(\.label) == ["Main", "Other"])
    }

    @Test func `native roster request preserves filters without unconditional transcript enrichment`() {
        for status in [OpenClawChatSidebarStatus.active, .snoozed, .archived, .all] {
            let query = OpenClawChatSidebarQuery(agentID: "main", status: status, ownerId: "alice")
            let request = RootSidebarModel.rosterRequest(query: query, limit: 200, offset: 400)
            #expect(request.method == "sessions.list")
            #expect(request.params["agentId"]?.value as? String == "main")
            #expect(request.params["ownerId"]?.value as? String == "alice")
            #expect(request.params["offset"]?.value as? Int == 400)
            #expect(request.params["includeDerivedTitles"]?.value as? Bool == false)
            #expect(request.params["includeLastMessage"]?.value as? Bool == false)
            switch status {
            case .active, .snoozed: #expect(request.params["archived"] == nil)
            case .archived: #expect(request.params["archived"]?.value as? Bool == true)
            case .all: #expect(request.params["archived"]?.value as? String == "all")
            }
            let preview = RootSidebarModel.rosterRequest(query: query, limit: 200, includePreview: true)
            #expect(preview.params["includeLastMessage"]?.value as? Bool == true)
            #expect(preview.params["includeDerivedTitles"]?.value as? Bool == false)
        }
        let involving = RootSidebarModel.rosterRequest(
            query: .init(agentID: "main", ownerId: "alice", involvingMe: true), limit: 200)
        #expect(involving.params["involvingMe"]?.value as? Bool == true)
        #expect(involving.params["ownerId"] == nil)
    }

    @Test func `model preserves first observed created-order ties across reordered roster refreshes`() async throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RootSidebarModel(preferences: defaults)
        model.viewOptions.sort = .created
        let app = NodeAppModel()
        let first = OpenClawChatSessionEntry(key: "agent:main:a")
        let second = OpenClawChatSessionEntry(key: "agent:main:b")
        var rows = [first, second]
        model.testRosterLoad = { ChatSessionRosterSnapshot(sessions: rows, isCached: false) }
        model.testGroupCatalogLoad = {}
        await model.refreshSessions(appModel: app)
        rows = [second, first]
        await model.refreshSessions(appModel: app)
        let sections = model.sections(
            query: "", currentSessionKey: "", mainSessionKey: "agent:main:main", activeAgentID: "main", groups: [])
        #expect(self.keys(sections) == [first.key, second.key])
        let third = OpenClawChatSessionEntry(key: "agent:main:c")
        rows = [third, first, second]
        await model.refreshSessions(appModel: app)
        let next = model.sections(
            query: "", currentSessionKey: "", mainSessionKey: "agent:main:main", activeAgentID: "main", groups: [])
        #expect(self.keys(next) == [first.key, second.key, third.key])
    }

    @Test func `model adopts new facets and clears previous connection facets when absent`() async throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RootSidebarModel(preferences: defaults)
        let app = NodeAppModel()
        let response = try self
            .response(
                #"{"sessions":[{"key":"agent:main:a"}],"owners":[{"type":"human","id":"alice","label":"Alice"}],"involvingProfileId":"alice"}"#)
        var snapshot = ChatSessionRosterSnapshot(
            sessions: response.sessions, isCached: false,
            owners: response.owners, involvingProfileID: response.involvingProfileId)
        model.testRosterLoad = { snapshot }
        model.testGroupCatalogLoad = {}
        await model.refreshSessions(appModel: app)
        #expect(model.owners?.map(\.id) == ["alice"])
        #expect(model.involvingProfileID == "alice")
        snapshot = ChatSessionRosterSnapshot(sessions: [], isCached: false)
        await model.refreshSessions(appModel: app)
        #expect(model.owners == nil)
        #expect(model.involvingProfileID == nil)
    }

    @Test func `membership-filtered events apply authoritative refresh instead of adopting event rows`() async throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RootSidebarModel(preferences: defaults)
        let app = NodeAppModel()
        let rows = try self.rows(#"""
        [{"key":"agent:main:a","sessionId":"a","kind":"direct","label":"Authoritative",
          "owner":{"actor":{"type":"human","id":"alice","label":"Alice"}}}]
        """#)
        var authoritativeRows = rows
        var rosterLoads = 0
        model.testRosterLoad = {
            rosterLoads += 1
            return ChatSessionRosterSnapshot(sessions: authoritativeRows, isCached: false)
        }
        model.testGroupCatalogLoad = {}
        await model.refreshSessions(appModel: app)
        var changed = try #require(rows.first)
        changed.label = "Unconfirmed membership"
        let row = try JSONSerialization.jsonObject(with: JSONEncoder().encode(changed))
        let event = EventFrame(type: "event", event: "sessions.changed", payload: AnyCodable([
            "sessionKey": changed.key, "reason": "patch", "session": row,
        ]))
        for owner in ["owner:alice", "involving-me"] {
            model.viewOptions.ownerFilter = owner
            authoritativeRows = owner == "owner:alice" ? [] : rows
            let before = rosterLoads
            _ = await model.handleSessionEvent(event, appModel: app)
            #expect(rosterLoads == before + 1)
            #expect(model.sessions == authoritativeRows)
            #expect(!model.sessions.contains { $0.label == "Unconfirmed membership" })
        }
        model.viewOptions.ownerFilter = ""
        model.showsAllAgents = true
        authoritativeRows = []
        let before = rosterLoads
        _ = await model.handleSessionEvent(event, appModel: app)
        #expect(rosterLoads == before + 1)
        #expect(model.sessions.isEmpty)
    }

    @Test func `all-agent observer digests update only their explicit owner without a roster reload`() async throws {
        let name = "RootSidebarMenuParityTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let model = RootSidebarModel(preferences: defaults)
        let app = NodeAppModel()
        model.showsAllAgents = true
        let rows = try self.rows(#"""
        [
          {"key":"shared","agentId":"main","sessionId":"main-row","kind":"direct",
           "status":"running","hasActiveRun":true,"activeRunIds":["same-run"]},
          {"key":"shared","agentId":"other","sessionId":"other-row","kind":"direct",
           "status":"running","hasActiveRun":true,"activeRunIds":["same-run"]}
        ]
        """#)
        var rosterLoads = 0
        model.testRosterLoad = {
            rosterLoads += 1
            return ChatSessionRosterSnapshot(sessions: rows, isCached: false)
        }
        model.testGroupCatalogLoad = {}
        await model.refreshSessions(appModel: app)
        let event = EventFrame(type: "event", event: "session.observer", payload: AnyCodable([
            "sessionKey": "shared", "agentId": "other", "runId": "same-run",
            "revision": 2, "updatedAt": 200, "headline": "Other only", "health": "stuck",
        ]))
        _ = await model.handleSessionEvent(event, appModel: app)
        #expect(model.sessions.first { $0.agentId == "main" }?.observerDigest == nil)
        #expect(model.sessions.first { $0.agentId == "other" }?.observerDigest?.headline == "Other only")
        #expect(rosterLoads == 1)
    }
}
