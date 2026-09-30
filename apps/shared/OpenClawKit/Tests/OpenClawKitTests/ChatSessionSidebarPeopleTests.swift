#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarPeopleTests {
    private enum LoadFailure: Error { case unavailable }

    private let presence = #"""
    [
      {"connectionId":"mac","ts":200000,"onlineSince":70000,"lastActivityAt":100000,
       "user":{"id":"self-tab","identity":{"type":"profile","id":"alice"},"name":" Alice "},
       "watchedSessions":["agent:main:release-plan"]},
      {"connectionId":"self-web","ts":200001,"onlineSince":60000,"lastActivityAt":120000,
       "user":{"id":"self-web","identity":{"type":"profile","id":"alice"},"name":"Alice"},
       "watchedSessions":["agent:main:release-plan","agent:main:other"]},
      {"connectionId":"bea-web","ts":200002,"lastActivityAt":90000,
       "user":{"id":"bea-tab","identity":{"type":"profile","id":"bea"},"name":"Bea"},
       "watchedSessions":["agent:main:release-plan"]},
      {"connectionId":"bea-phone","ts":200003,
       "user":{"id":"bea-phone","identity":{"type":"profile","id":"bea"},"name":"Bea"},
       "watchedSessions":["agent:main:release-plan"]},
      {"connectionId":"raw","ts":999999,"connectionLastActivityAt":999999,
       "user":{"id":"bea","name":"Guest"},"watchedSessions":["agent:main:release-plan"]},
      {"connectionId":"gone","ts":999999,"reason":"disconnect","lastActivityAt":999999,
       "user":{"id":"gone","identity":{"type":"profile","id":"gone"}}},
      {"connectionId":"service","ts":999999},
      {"connectionId":"empty","ts":999999,"user":{"id":""}}
    ]
    """#

    private func hello(
        _ presence: String, connectionID: String = "mac", mainKey: String = "main",
        globalScope: Bool = false) throws -> HelloOk
    {
        let mainSessionKey = globalScope ? "global" : "agent:main:\(mainKey)"
        return try JSONDecoder().decode(HelloOk.self, from: Data("""
        {"type":"hello-ok","protocol":4,"server":{"connId":"\(connectionID)"},"features":{},
         "snapshot":{"presence":\(presence),"health":{},
                     "sessionDefaults":{"defaultAgentId":"main","mainKey":"\(mainKey)","mainSessionKey":"\(mainSessionKey)"},
                     "stateVersion":{"presence":1,"health":1},"uptimeMs":0},"auth":{},"policy":{}}
        """.utf8))
    }

    private func live(_ presence: String) -> Data {
        Data("{\"presence\":\(presence)}".utf8)
    }

    private func response(_ json: String) throws -> OpenClawChatSessionsListResponse {
        try OpenClawChatGatewayPayloadCodec.decodeSessionsList(Data(json.utf8), agentID: "main")
    }

    @Test func `hello and live presence group identities while Online includes self and viewers do not`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        #expect(people.selfKey == "profile:alice")
        #expect(people.online(at: Date(timeIntervalSince1970: 200), expanded: false).map(\.id) == [
            "profile:alice", "profile:bea", "raw:bea",
        ])
        let alice = try #require(people.people.first { $0.id == "profile:alice" })
        #expect(alice.label == "Alice")
        #expect(alice.entries.count == 2)
        #expect(alice.onlineSince == 60000)
        #expect(alice.watchedSessions == ["agent:main:release-plan", "agent:main:other"])
        #expect(people.viewers(for: "agent:main:release-plan").map(\.id) == ["profile:bea", "raw:bea"])
        #expect(people.viewers(for: "agent:main:release-plan", excludingProfileIDs: ["bea"]).map(\.id) == [
            "raw:bea",
        ])
        #expect(people.viewers(for: "agent:main:other").isEmpty)

        #expect(try people.receivePresence(self.live(#"""
        [{"connectionId":"mac","ts":200004,"user":{"id":"alice","identity":{"type":"profile","id":"alice"}}},
         {"connectionId":"bea-web","ts":200004,"reason":"disconnect",
          "user":{"id":"bea","identity":{"type":"profile","id":"bea"}}}]
        """#)) == false)
        #expect(people.people.map(\.id) == ["profile:alice"])
        #expect(people.viewers(for: "agent:main:release-plan").isEmpty)
    }

    @Test func `activity expires at the exact last human activity boundary without a new presence event`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        let alice = try #require(people.people.first { $0.id == "profile:alice" })
        let bea = try #require(people.people.first { $0.id == "profile:bea" })
        let guest = try #require(people.people.first { $0.id == "raw:bea" })
        let before = Date(timeIntervalSince1970: 209.999)
        people.refreshActivity(at: before)
        #expect(people.activityTime == before)
        #expect(alice.activity(at: people.activityTime) == .active)
        #expect(bea.activity(at: people.activityTime) == .active)
        #expect(guest.activity(at: people.activityTime) == .unknown)
        #expect(people.nextActivityDeadline(after: before) == Date(timeIntervalSince1970: 210))

        people.refreshActivity(at: Date(timeIntervalSince1970: 210))
        #expect(alice.activity(at: people.activityTime) == .active)
        #expect(bea.activity(at: people.activityTime) == .idle)
        #expect(people.nextActivityDeadline(after: people.activityTime) == Date(timeIntervalSince1970: 240))
        people.refreshActivity(at: Date(timeIntervalSince1970: 240))
        #expect(alice.activity(at: people.activityTime) == .idle)
        #expect(people.nextActivityDeadline(after: people.activityTime) == nil)
        #expect(people.online(expanded: true).map(\.id) == ["profile:alice", "profile:bea", "raw:bea"])
    }

    @Test func `owner counts use the complete facet rather than the loaded session page and recover after failure`() async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        let alice = try #require(people.people.first { $0.id == "profile:alice" })
        let bea = try #require(people.people.first { $0.id == "profile:bea" })
        let guest = try #require(people.people.first { $0.id == "raw:bea" })
        let page = try self.response(#"""
        {"count":1,"totalCount":205,"hasMore":true,"sessions":[
          {"key":"agent:bulk:one","owner":{"actor":{"type":"human","identity":{"type":"profile","id":"alice"}}}}
        ]}
        """#)
        await people.refreshCounts { page.ownerSessionCounts }
        #expect(people.workload(for: alice) == nil)
        await people.refreshCounts { throw LoadFailure.unavailable }
        #expect(people.countsFailed)
        #expect(people.workload(for: alice) == nil)

        let complete = try self.response(#"""
        {"count":1,"totalCount":205,"hasMore":true,"sessions":[{"key":"agent:bulk:one"}],
         "ownerSessionCounts":[{"profileId":"alice","open":205,"running":3}]}
        """#)
        await people.refreshCounts { complete.ownerSessionCounts }
        #expect(!people.countsFailed)
        #expect(people.workload(for: alice)?._open == 205)
        #expect(people.workload(for: alice)?.running == 3)
        #expect(people.workload(for: bea)?._open == 0)
        #expect(people.workload(for: guest) == nil)
        await people.refreshCounts { throw LoadFailure.unavailable }
        #expect(people.countsFailed)
        #expect(people.workload(for: alice)?._open == 205)
        await people.refreshCounts { try self.response(#"{"sessions":[],"ownerSessionCounts":[]}"#).ownerSessionCounts }
        #expect(!people.countsFailed)
        #expect(people.workload(for: alice)?._open == 0)

        let request = OpenClawChatSidebarPeople.ownerCountsRequest
        #expect(request.method == "sessions.list")
        #expect(request.params == [
            "includeOwnerSessionCounts": AnyCodable(true), "configuredAgentsOnly": AnyCodable(true),
            "limit": AnyCodable(1), "includeDerivedTitles": AnyCodable(false), "includeLastMessage": AnyCodable(false),
            "includeGlobal": AnyCodable(false), "includeUnknown": AnyCodable(false),
            "excludeSubagents": AnyCodable(true), "excludeCron": AnyCodable(true), "excludeSystem": AnyCodable(true),
        ])
    }

    @Test func `the first authenticated person invalidates counts even when self is unqualified`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(#"[{"connectionId":"raw","ts":1,"user":{"id":"guest"}}]"#))
        #expect(people.selfKey == nil)
        #expect(try people.receivePresence(self.live(#"""
        [{"connectionId":"raw","ts":2,"user":{"id":"guest"}},
         {"connectionId":"bea","ts":2,"user":{"id":"bea","identity":{"type":"profile","id":"bea"}}}]
        """#)))
        #expect(people.selfKey == nil)
        #expect(people.people.map(\.id) == ["profile:bea", "raw:guest"])
    }

    @Test(arguments: ["hello", "live", "disconnect"])
    func `retired account and disconnected count requests cannot publish`(replacement: String) async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        await people.refreshCounts {
            if replacement == "disconnect" {
                people.disconnect()
            } else {
                let presence = #"""
                [{"connectionId":"mac","ts":2,"user":{"id":"bea","identity":{"type":"profile","id":"bea"}}}]
                """#
                if replacement == "live" {
                    try people.receivePresence(self.live(presence))
                } else {
                    try people.receive(self.hello(presence))
                }
            }
            return try self
                .response(#"{"sessions":[],"ownerSessionCounts":[{"profileId":"alice","open":205,"running":3}]}"#)
                .ownerSessionCounts
        }
        #expect(people.counts == nil)
        #expect(!people.countsFailed)
        #expect(people.selfKey == (replacement == "disconnect" ? nil : "profile:bea"))
    }

    @Test(arguments: [false, true])
    func `newer owner counts win over a late successful or failed refresh`(olderFails: Bool) async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        await people.refreshCounts {
            await people.refreshCounts {
                try self.response(#"{"sessions":[],"ownerSessionCounts":[{"profileId":"bea","open":4,"running":1}]}"#)
                    .ownerSessionCounts
            }
            if olderFails { throw LoadFailure.unavailable }
            return try self
                .response(#"{"sessions":[],"ownerSessionCounts":[{"profileId":"alice","open":205,"running":3}]}"#)
                .ownerSessionCounts
        }
        #expect(people.counts?["bea"]?._open == 4)
        #expect(people.counts?["alice"] == nil)
        #expect(!people.countsFailed)
        #expect(people.online(at: Date(timeIntervalSince1970: 200), expanded: true).map(\.id) == [
            "profile:bea", "profile:alice", "raw:bea",
        ])
        #expect(people.online(at: Date(timeIntervalSince1970: 200), expanded: false).map(\.id) == [
            "profile:alice", "profile:bea", "raw:bea",
        ])
    }

    @Test func `presence gaps clear stale people and counts until authoritative recovery`() async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        await people.refreshCounts { try self.response(#"{"sessions":[],"ownerSessionCounts":[]}"#).ownerSessionCounts }
        await people.resynchronizePresence {
            #expect(people.people.isEmpty)
            #expect(people.counts == nil)
            throw LoadFailure.unavailable
        }
        #expect(people.presenceFailed)
        #expect(people.people.isEmpty)
        await people.resynchronizePresence { Data(self.presence.utf8) }
        #expect(!people.presenceFailed)
        #expect(people.selfKey == "profile:alice")
        #expect(people.people.map(\.id) == ["profile:alice", "profile:bea", "raw:bea"])
        #expect(people.counts == nil)
    }

    @Test(arguments: ["live", "hello", "disconnect"])
    func `a presence recovery cannot overwrite newer live connection state`(replacement: String) async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        let latest = #"[{"connectionId":"mac","ts":300000,"user":{"id":"new","identity":{"type":"profile","id":"new"}}}]"#
        await people.resynchronizePresence {
            switch replacement {
            case "live": try people.receivePresence(self.live(latest))
            case "hello": try people.receive(self.hello(latest))
            default: people.disconnect()
            }
            return Data(self.presence.utf8)
        }
        #expect(!people.presenceFailed)
        #expect(people.people.map(\.id) == (replacement == "disconnect" ? [] : ["profile:new"]))
        #expect(people.selfKey == (replacement == "disconnect" ? nil : "profile:new"))
    }

    @Test func `disconnected people ignore stale live events and do not start recovery or count requests`() async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        people.disconnect()
        #expect(try people.receivePresence(self.live(self.presence)) == false)
        var loaded = false
        await people.resynchronizePresence { loaded = true
            return Data(self.presence.utf8)
        }
        await people.refreshCounts { loaded = true
            return []
        }
        #expect(!loaded)
        #expect(people.people.isEmpty)
        #expect(people.counts == nil)
        #expect(people.selfKey == nil)
        #expect(people.nextActivityDeadline(after: .distantPast) == nil)
    }

    @Test func `person cards resolve scoped main aliases without borrowing the selected agents route`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(#"""
        [{"connectionId":"mac","ts":1,"user":{"id":"alice","identity":{"type":"profile","id":"alice"}},
          "watchedSessions":["agent:bulk:home"]}]
        """#, mainKey: "home"))
        let person = try #require(people.people.first)
        let page = try self.response(#"""
        {"sessions":[{"key":"main","agentId":"bulk","updatedAt":200},
          {"key":"agent:bulk:main","updatedAt":100},{"key":"agent:main:home","updatedAt":300}]}
        """#)
        let card = people.cardSessions(for: person, sessions: page.sessions)
        #expect(card.viewing.map(\.key) == ["main"])
    }

    @Test func `person cards intersect authorized rows and deduplicate canonical session identities`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(#"""
        [{"connectionId":"mac","ts":1,"user":{"id":"alice","identity":{"type":"profile","id":"alice"}},
          "watchedSessions":["main","release-plan","secret-not-loaded"]}]
        """#))
        let person = try #require(people.people.first)
        let page = try self.response(#"""
        {"sessions":[
          {"key":"main","updatedAt":100},
          {"key":"agent:main:main","updatedAt":999},
          {"key":"agent:main:release-plan","updatedAt":200},
          {"key":"agent:bulk:release-plan","updatedAt":1000},
          {"key":"created","updatedAt":400,"createdActor":{"type":"human","identity":{"type":"profile","id":"alice"}}},
          {"key":"owned","updatedAt":300,"owner":{"actor":{"type":"human","identity":{"type":"profile","id":"alice"}}}},
          {"key":"third","updatedAt":200,"createdActor":{"type":"human","identity":{"type":"profile","id":"alice"}}},
          {"key":"fourth","updatedAt":100,"createdActor":{"type":"human","identity":{"type":"profile","id":"alice"}}},
          {"key":"raw-id-lookalike","updatedAt":1000,"createdActor":{"type":"human","id":"alice"}},
          {"key":"foreign-profile","updatedAt":1000,"createdActor":{"type":"human","identity":{"type":"profile","id":"bea"}}}
        ]}
        """#)
        let card = people.cardSessions(for: person, sessions: page.sessions)
        #expect(card.viewing.map(\.key) == ["agent:main:release-plan", "main"])
        #expect(card.recent.map(\.key) == ["created", "owned", "third"])
    }

    @Test func `global main aliases keep each loaded rows agent ownership`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(#"""
        [{"connectionId":"mac","ts":1,"user":{"id":"alice"},"watchedSessions":["global"]}]
        """#, mainKey: "home", globalScope: true))
        let page = try self.response(#"""
        {"sessions":[{"key":"agent:main:main"},{"key":"global","agentId":"main"},
          {"key":"agent:bulk:home"},{"key":"global","agentId":"bulk"}]}
        """#)
        let card = try people.cardSessions(for: #require(people.people.first), sessions: page.sessions)
        #expect(card.viewing.map(\.key) == ["agent:main:main"])
    }

    @Test(arguments: [
        ("catalog:Source:OpaqueID", "catalog:Source:OpaqueID"),
        ("matrix:channel:!Room:example:thread:Event", "MATRIX:CHANNEL:!Room:example:THREAD:Event"),
        ("signal:group:OpaqueID:topic", "SIGNAL:GROUP:OpaqueID:TOPIC"),
    ])
    func `card identities preserve opaque tails while normalizing routing words`(keys: (String, String)) throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello("""
        [{"connectionId":"mac","ts":1,"user":{"id":"alice"},"watchedSessions":["agent:main:\(keys.0)"]}]
        """))
        let page = try self.response("""
        {"sessions":[{"key":"Agent:MAIN:\(keys.1)"},{"key":"agent:main:\(keys.0.lowercased())"}]}
        """)
        let card = try people.cardSessions(for: #require(people.people.first), sessions: page.sessions)
        #expect(card.viewing.map(\.key) == ["Agent:MAIN:\(keys.1)"])
    }

    @Test func `activity links keep retained profile IDs exact instead of looking like short references`() {
        #expect(OpenClawChatSidebarPeople.activityPath(for: "legacy-deadbeef") == "/activity/legacy%2Ddeadbeef")
        #expect(OpenClawChatSidebarPeople.activityPath(for: "name/with.dot") == "/activity/name%2Fwith%2Edot")
    }

    @Test func `Online collation ties keep projected order regardless of running magnitude`() async throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(#"""
        [{"connectionId":"mac","ts":1,"lastActivityAt":100000,
          "user":{"id":"a","identity":{"type":"profile","id":"a"},"name":"Áda"}},
         {"connectionId":"web","ts":1,"lastActivityAt":100000,
          "user":{"id":"z","identity":{"type":"profile","id":"z"},"name":"Ada"}}]
        """#))
        await people.refreshCounts {
            try self.response(#"""
            {"sessions":[],"ownerSessionCounts":[{"profileId":"a","open":100,"running":99},
              {"profileId":"z","open":2,"running":1}]}
            """#).ownerSessionCounts
        }
        #expect(people.online(at: Date(timeIntervalSince1970: 100), expanded: true).map(\.id) == [
            "profile:z",
            "profile:a",
        ])
    }

    @Test func `card timestamp ties normalize missing timestamps before sorting identities`() throws {
        let people = OpenClawChatSidebarPeople()
        try people.receive(self.hello(self.presence))
        let page = try self.response(#"""
        {"sessions":[
          {"key":"zebra","createdActor":{"type":"human","identity":{"type":"profile","id":"alice"}}},
          {"key":"apple","updatedAt":0,"createdActor":{"type":"human","identity":{"type":"profile","id":"alice"}}}
        ]}
        """#)
        let person = try #require(people.people.first { $0.id == "profile:alice" })
        #expect(people.cardSessions(for: person, sessions: page.sessions).recent.map(\.key) == ["apple", "zebra"])
    }
}
#endif
