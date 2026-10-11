import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSidebarPeopleFilterTests {
    private let entries = #"""
    [
      {"ts":200000,"lastActivityAt":199000,"user":{"id":"alice-web","identity":{"type":"profile","id":"alice"},"name":"Alice"}},
      {"ts":200000,"lastActivityAt":199000,"user":{"id":"bea-web","identity":{"type":"profile","id":"bea"},"name":"Bea"}},
      {"ts":200000,"lastActivityAt":1000,"user":{"id":"charles-web","identity":{"type":"profile","id":"charles"},"name":"Charles"}},
      {"ts":200000,"user":{"id":"guest","name":"Guest"}}
    ]
    """#

    private func connected() async -> OpenClawChatSidebarPeople {
        let people = OpenClawChatSidebarPeople()
        people.beginConnection()
        await people.resynchronizePresence { Data(self.entries.utf8) }
        await people.refreshCounts {
            [
                SessionOwnerSessionCount(profileid: "alice", _open: 7, running: 0),
                SessionOwnerSessionCount(profileid: "bea", _open: 2, running: 1),
                SessionOwnerSessionCount(profileid: "charles", _open: 8, running: 3),
            ]
        }
        people.refreshActivity(at: Date(timeIntervalSince1970: 200))
        return people
    }

    @Test func `presence groups stay primary by default while explicit count sorts cross them`() async {
        let people = await self.connected()
        #expect(people.online(status: .all, sort: .presence).map(\.label) == ["Bea", "Alice", "Charles", "Guest"])
        #expect(people.online(status: .all, sort: .running).map(\.label) == ["Charles", "Bea", "Alice", "Guest"])
        #expect(people.online(status: .all, sort: .open).map(\.label) == ["Charles", "Alice", "Bea", "Guest"])
        #expect(people.online(status: .all, sort: .name).map(\.label) == ["Alice", "Bea", "Charles", "Guest"])
        #expect(people.online(status: .running, sort: .name).map(\.label) == ["Bea", "Charles"])
    }

    @Test func `unknown count facets never claim running people or borrow loaded roster counts`() async throws {
        let people = OpenClawChatSidebarPeople()
        people.beginConnection()
        await people.resynchronizePresence { Data(self.entries.utf8) }
        #expect(people.online(status: .running, sort: .running).isEmpty)
        #expect(people.online(status: .all, sort: .name).count == 4)
        await people.refreshCounts { [] }
        #expect(people.online(status: .running, sort: .presence).isEmpty)
        let guest = try #require(people.people.first { $0.id == "raw:guest" })
        let alice = try #require(people.people.first { $0.id == "profile:alice" })
        #expect(people.workload(for: guest) == nil)
        #expect(people.workload(for: alice)?._open == 0)
    }

    @Test func `pushed presence supersedes a suspended system-presence snapshot`() async throws {
        let people = await self.connected()
        var continuation: CheckedContinuation<Data, Never>?
        let (started, signal) = AsyncStream<Void>.makeStream()
        let loading = Task { @MainActor in
            await people.resynchronizePresence {
                await withCheckedContinuation {
                    continuation = $0
                    signal.yield(())
                    signal.finish()
                }
            }
        }
        var iterator = started.makeAsyncIterator()
        await iterator.next()
        let pending = try #require(continuation)
        let fresh = #"{"presence":[{"ts":300000,"user":{"id":"fresh","name":"Fresh"}}]}"#
        try people.receivePresence(Data(fresh.utf8))
        pending.resume(returning: Data(self.entries.utf8))
        await loading.value
        #expect(people.people.map(\.label) == ["Fresh"])
        #expect(!people.presenceFailed)
    }

    @Test func `disconnect retires an in-flight facet and requires fresh presence on reconnect`() async throws {
        let people = await self.connected()
        var continuation: CheckedContinuation<[SessionOwnerSessionCount]?, Never>?
        let (started, signal) = AsyncStream<Void>.makeStream()
        let loading = Task { @MainActor in
            await people.refreshCounts {
                await withCheckedContinuation {
                    continuation = $0
                    signal.yield(())
                    signal.finish()
                }
            }
        }
        var iterator = started.makeAsyncIterator()
        await iterator.next()
        let pending = try #require(continuation)
        people.disconnect()
        people.beginConnection()
        pending.resume(returning: [SessionOwnerSessionCount(profileid: "alice", _open: 99, running: 99)])
        await loading.value
        #expect(people.people.isEmpty)
        #expect(people.counts == nil)
        await people.resynchronizePresence { Data(self.entries.utf8) }
        #expect(people.online(status: .running, sort: .running).isEmpty)
    }

    @Test func `presence-only connections preserve named-main session aliases without exposing unlisted titles`() async throws {
        let people = OpenClawChatSidebarPeople()
        people.beginConnection(defaultAgentID: "marvin", mainSessionKey: "agent:marvin:desk")
        await people.resynchronizePresence {
            Data(
                #"[{"ts":200000,"user":{"id":"guest","name":"Guest"},"watchedSessions":["main","agent:marvin:unlisted"]}]"#
                    .utf8)
        }
        let person = try #require(people.people.first)
        let data = Data(#"{"ts":1,"count":1,"sessions":[{"key":"agent:marvin:desk","label":"Allowed title"}]}"#.utf8)
        let rows = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(data, agentID: "marvin").sessions
        let card = people.cardSessions(for: person, sessions: rows)
        #expect(card.viewing.map(\.key) == ["agent:marvin:desk"])
        #expect(card.viewingKeys.count == 1)
    }
}
