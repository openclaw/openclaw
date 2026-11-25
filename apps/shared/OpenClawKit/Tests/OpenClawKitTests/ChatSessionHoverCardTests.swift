import Foundation
import Observation
import struct OpenClawKit.GatewayResponseError
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

#if os(macOS)
private actor HoverFactsWire {
    struct Pending: Sendable {
        let request: OpenClawChatGatewayRequest
        let reply: CheckedContinuation<Data, any Error>
    }

    private var calls: [String: [Pending]] = [:]
    private var waiters: [String: CheckedContinuation<Pending, Never>] = [:]

    func send(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { reply in
            let call = Pending(request: request, reply: reply)
            if let waiter = self.waiters.removeValue(forKey: request.method) {
                waiter.resume(returning: call)
            } else { self.calls[request.method, default: []].append(call) }
        }
    }

    func next(_ method: String = "controlUi.sessionPullRequests.subscribe") async -> Pending {
        if self.calls[method]?.isEmpty == false { return self.calls[method]!.removeFirst() }
        return await withCheckedContinuation { self.waiters[method] = $0 }
    }
}

@MainActor
struct ChatSessionHoverCardTests {
    private let empty = Data(#"{"card":null}"#.utf8)
    private let acknowledged = Data(#"{"subscribed":true}"#.utf8)

    private func keys(_ call: HoverFactsWire.Pending, field: String = "sessionKeys") throws -> [String] {
        let data = try JSONEncoder().encode(call.request.params)
        let params = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require(params[field] as? [String])
    }

    private func changed(
        _ facts: OpenClawChatSidebarHoverFacts,
        key: String,
        agentID: String? = nil,
        reply: () -> Void) async
    {
        await withCheckedContinuation { continuation in
            withObservationTracking { _ = facts.progress(sessionKey: key, agentID: agentID) } onChange: {
                continuation.resume()
            }
            reply()
        }
    }

    private func card(_ key: String, revision: Int) -> Data {
        Data(#"{"card":{"sessionKey":"\#(key)","revision":\#(revision),"updatedAt":123,"markdown":"Working"}}"#.utf8)
    }

    private func pulls(_ facts: OpenClawChatSidebarHoverFacts, _ snapshot: String, key: String = "agent:main:work") {
        facts.receive(event: "controlUi.sessionPullRequests.changed", payload: Data(
            #"{"sessions":{"\#(key)":\#(snapshot)}}"#.utf8))
    }

    @Test func `channel images and missing avatars are shared only for the watched revision`() async {
        let facts = OpenClawChatSidebarHoverFacts()
        let first = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let second = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        var loads = 0
        func avatar(_ version: String, result: OpenClawChatSidebarHoverFacts.AvatarResult) async -> Data? {
            await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: version) {
                loads += 1
                return result
            }
        }
        let image = Data([1, 2, 3])
        #expect(await avatar("v1", result: .image(image)) == image)
        facts.unwatch(first)
        #expect(await avatar("v1", result: .unavailable) == image)
        #expect(loads == 1)
        #expect(await avatar("v2", result: .notFound) == nil)
        #expect(await avatar("v2", result: .image(image)) == nil)
        #expect(loads == 2)
        #expect(await avatar("v3", result: .unavailable) == nil)
        #expect(await avatar("v3", result: .image(image)) == image)
        #expect(loads == 4)
        facts.unwatch(second)
        let replacement = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        #expect(await avatar("v3", result: .notFound) == nil)
        #expect(loads == 5)
        facts.unwatch(replacement)
    }

    @Test func `channel avatar fetch is shared and retired across reconnect`() async {
        let facts = OpenClawChatSidebarHoverFacts()
        let wire = HoverFactsWire()
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let fetch = Task {
            await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v1") {
                do {
                    return try await .image(wire.send(.init(method: "avatar", params: [:], timeoutMs: 15000)))
                } catch {
                    Issue.record(error)
                    return .unavailable
                }
            }
        }
        let pending = await wire.next("avatar")
        var duplicateFetch = false
        let duplicate = Task {
            await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v1") {
                duplicateFetch = true
                return .notFound
            }
        }
        pending.reply.resume(returning: Data([1]))
        #expect(await fetch.value == Data([1]))
        #expect(await duplicate.value == Data([1]))
        #expect(!duplicateFetch)
        let retired = Task {
            await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v2") {
                do {
                    return try await .image(wire.send(.init(method: "avatar", params: [:], timeoutMs: 15000)))
                } catch {
                    Issue.record(error)
                    return .unavailable
                }
            }
        }
        let old = await wire.next("avatar")
        facts.connect { [empty = self.empty] _ in empty }
        old.reply.resume(returning: Data([2]))
        #expect(await retired.value == nil)
        #expect(await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v2") {
            .image(Data([3]))
        } == Data([3]))
        facts.disconnect()
        facts.unwatch(owner)
    }

    @Test func `channel and agent images coexist while agent misses remain revision scoped`() async {
        let facts = OpenClawChatSidebarHoverFacts()
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let resources: [OpenClawChatSidebarHoverFacts.AvatarResource] = [.channel, .agent("research"), .agent("ops")]
        for (index, resource) in resources.enumerated() {
            #expect(await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v1", resource: resource) {
                .image(Data([UInt8(index)]))
            } == Data([UInt8(index)]))
        }
        for (index, resource) in resources.enumerated() {
            #expect(await facts.avatar(sessionKey: "agent:main:work", agentID: nil, version: "v1", resource: resource) {
                .unavailable
            } == Data([UInt8(index)]))
        }
        #expect(await facts
            .avatar(sessionKey: "agent:main:work", agentID: nil, version: "v2", resource: .agent("ops")) {
                .notFound
            } == nil)
        #expect(await facts
            .avatar(sessionKey: "agent:main:work", agentID: nil, version: "v2", resource: .agent("ops")) {
                Issue.record("Repeated consumers should share an unexpired agent image miss")
                return .image(Data([3]))
            } == nil)
        #expect(await facts
            .avatar(sessionKey: "agent:main:work", agentID: nil, version: "v3", resource: .agent("ops")) {
                .image(Data([4]))
            } == Data([4]))
        facts.unwatch(owner)
    }

    @Test func `closing last watch waits for empty acknowledgement`() async throws {
        enum Event: Sendable { case request(HoverFactsWire.Pending), stopped }
        let events = AsyncStream.makeStream(of: Event.self)
        weak var active: OpenClawChatSidebarHoverFacts?
        let facts = OpenClawChatSidebarHoverFacts { running in
            if !running {
                active?.disconnect()
                events.continuation.yield(.stopped)
            }
        }
        active = facts
        facts.connect { [empty = self.empty] request in
            if request.method == "progressCard.get" { return empty }
            return try await withCheckedThrowingContinuation { reply in
                events.continuation.yield(.request(.init(request: request, reply: reply)))
            }
        }
        defer { facts.disconnect()
            events.continuation.finish()
        }
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        var iterator = events.stream.makeAsyncIterator()
        guard case let .request(first) = await iterator.next() else { Issue.record("Missing initial watch")
            return
        }
        #expect(try self.keys(first) == ["agent:main:work"])
        facts.unwatch(owner)
        first.reply.resume(returning: self.acknowledged)
        guard case let .request(empty) = await iterator.next() else {
            Issue.record("Stopped before sending the empty subscription set")
            return
        }
        #expect(try self.keys(empty).isEmpty)
        empty.reply.resume(returning: self.acknowledged)
        guard case .stopped = await iterator.next() else { Issue.record("Did not stop after unsubscribe")
            return
        }
    }

    @Test func `windows share a replace set and global progress preserves its selected owner`() async throws {
        let wire = HoverFactsWire()
        var stopped: CheckedContinuation<Void, Never>?
        let facts = OpenClawChatSidebarHoverFacts { active in if !active { stopped?.resume()
            stopped = nil
        } }
        facts.connect { try await wire.send($0) }
        let research = facts.watch(sessionKey: "global", agentID: "research")
        let ops = facts.watch(sessionKey: "global", agentID: "ops")
        let subscribe = await wire.next()
        #expect(try self.keys(subscribe) == ["agent:ops:global", "agent:research:global"])
        subscribe.reply.resume(returning: self.acknowledged)
        var owners: Set<String> = []
        for _ in 0..<2 {
            let progress = await wire.next("progressCard.get")
            #expect(progress.request.params["sessionKey"]?.value as? String == "global")
            try owners.insert(#require(progress.request.params["agentId"]?.value as? String))
            progress.reply.resume(returning: self.empty)
        }
        #expect(owners == ["research", "ops"])
        facts.unwatch(research)
        let remaining = await wire.next()
        #expect(try self.keys(remaining) == ["agent:ops:global"])
        remaining.reply.resume(returning: self.acknowledged)
        facts.unwatch(ops)
        let unsubscribe = await wire.next()
        #expect(try self.keys(unsubscribe).isEmpty)
        await withCheckedContinuation { continuation in
            stopped = continuation
            unsubscribe.reply.resume(returning: self.acknowledged)
        }
    }

    @Test func `PR failures retain matching checkout facts and final unwatch retires them`() {
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { [empty = self.empty] _ in empty }
        let owner = facts.watch(sessionKey: "work", agentID: "main")
        self.pulls(facts, #"""
        {"pullRequests":[{"number":42,"owner":"openclaw","repo":"openclaw","branch":"work",
          "title":"Sidebar","url":"https://github.com/openclaw/openclaw/pull/42","state":"merged",
          "additions":8,"deletions":3,"checks":{"state":"passing","passed":2,"failed":0,"skipped":0,"running":0}},
          {"number":43,"owner":"openclaw","repo":"openclaw","branch":"work","title":"Active",
           "url":"https://github.com/openclaw/openclaw/pull/43","state":"open"}],
         "rateLimited":false,"status":"ready"}
        """#)
        self.pulls(facts, #"{"pullRequests":[],"rateLimited":true,"status":"rate-limited"}"#)
        #expect(facts.pullRequests(sessionKey: "work", agentID: "main")?.pullRequests.first?.number == 42)
        self.pulls(facts, #"""
        {"pullRequests":[],"repository":{"owner":"other","repo":"project"},"rateLimited":false,"status":"unavailable"}
        """#)
        #expect(facts.pullRequests(sessionKey: "work", agentID: "main")?.pullRequests.isEmpty == true)
        facts.unwatch(owner)
        #expect(facts.pullRequests(sessionKey: "work", agentID: "main") == nil)
    }

    @Test func `evicted PR snapshot is refreshed during watch handoff`() async throws {
        let wire = HoverFactsWire()
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { [empty = self.empty] request in
            request.method == "progressCard.get" ? empty : try await wire.send(request)
        }
        let firstOwner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let initial = await wire.next()
        initial.reply.resume(returning: self.acknowledged)
        facts.refresh()
        let inFlight = await wire.next()
        self.pulls(facts, #"""
        {"pullRequests":[{"number":42,"owner":"openclaw","repo":"openclaw","branch":"work",
         "title":"Sidebar","url":"https://github.com/openclaw/openclaw/pull/42","state":"open"}],
         "rateLimited":false,"status":"ready"}
        """#)
        #expect(facts.pullRequests(sessionKey: "agent:main:work", agentID: nil)?.pullRequests.count == 1)
        facts.unwatch(firstOwner)
        let replacement = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let barrier = facts.watch(sessionKey: "agent:main:barrier", agentID: nil)
        // A later all-key refresh guarantees an observable boundary if the handoff incorrectly skips its own request.
        facts.refresh()
        inFlight.reply.resume(returning: self.acknowledged)
        let union = await wire.next()
        #expect(try self.keys(union) == ["agent:main:barrier", "agent:main:work"])
        union.reply.resume(returning: self.acknowledged)
        let handoff = await wire.next()
        #expect(try self.keys(handoff, field: "refreshSessionKeys") == ["agent:main:work"])
        handoff.reply.resume(returning: self.acknowledged)
        facts.disconnect()
        facts.unwatch(replacement)
        facts.unwatch(barrier)
    }

    @Test func `global and ordinary progress remain distinct despite shared events`() async throws {
        let wire = HoverFactsWire()
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { try await wire.send($0) }
        let global = facts.watch(sessionKey: "global", agentID: "ops")
        let subscribe = await wire.next()
        #expect(try self.keys(subscribe) == ["agent:ops:global"])
        subscribe.reply.resume(returning: self.acknowledged)
        let first = await wire.next("progressCard.get")
        #expect(first.request.params["sessionKey"]?.value as? String == "global")
        await self.changed(facts, key: "global", agentID: "ops") {
            first.reply.resume(returning: self.card("agent:ops:global", revision: 1))
        }
        let ordinary = facts.watch(sessionKey: "agent:ops:global", agentID: "ops")
        defer { facts.disconnect()
            facts.unwatch(global)
            facts.unwatch(ordinary)
        }
        guard facts.progress(sessionKey: "agent:ops:global", agentID: "ops") == nil else {
            Issue.record("An ordinary session displayed the literal global session's notepad")
            return
        }
        let second = await wire.next("progressCard.get")
        #expect(second.request.params["sessionKey"]?.value as? String == "agent:ops:global")
        #expect(second.request.params["agentId"] == nil)
        await self.changed(facts, key: "agent:ops:global", agentID: "ops") {
            second.reply.resume(returning: self.card("agent:ops:global", revision: 2))
        }
        #expect(facts.progress(sessionKey: "global", agentID: "ops")?.revision == 1)
        #expect(facts.progress(sessionKey: "agent:ops:global", agentID: "ops")?.revision == 2)
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:ops:global","revision":null}"#.utf8))
        var refreshed = Set<String>()
        for _ in 0..<2 {
            let call = await wire.next("progressCard.get")
            let key = try #require(call.request.params["sessionKey"]?.value as? String)
            refreshed.insert(key)
            await self.changed(facts, key: key, agentID: "ops") {
                call.reply.resume(returning: key == "global" ? self.card("agent:ops:global", revision: 1) : self.empty)
            }
        }
        #expect(refreshed == ["global", "agent:ops:global"])
        #expect(facts.progress(sessionKey: "global", agentID: "ops")?.revision == 1)
        #expect(facts.progress(sessionKey: "agent:ops:global", agentID: "ops") == nil)
    }

    @Test func `progress invalidation overtakes a pending absent response`() async {
        let wire = HoverFactsWire()
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { try await wire.send($0) }
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let subscribe = await wire.next()
        subscribe.reply.resume(returning: self.acknowledged)
        let first = await wire.next("progressCard.get")
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:main:work","revision":2}"#.utf8))
        first.reply.resume(returning: self.empty)
        let followup = await wire.next("progressCard.get")
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil) == nil)
        await self.changed(facts, key: "agent:main:work") {
            followup.reply.resume(returning: self.card("agent:main:work", revision: 2))
        }
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil)?.revision == 2)
        facts.disconnect()
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil) == nil)
        facts.unwatch(owner)
    }

    @Test func `participation denial clears cached notepad before another read`() async {
        let wire = HoverFactsWire()
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { try await wire.send($0) }
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let subscribe = await wire.next()
        subscribe.reply.resume(returning: self.acknowledged)
        let initial = await wire.next("progressCard.get")
        await self.changed(facts, key: "agent:main:work") {
            initial.reply.resume(returning: self.card("agent:main:work", revision: 1))
        }
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:main:work","revision":2}"#.utf8))
        let transient = await wire.next("progressCard.get")
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:main:work","revision":3}"#.utf8))
        transient.reply.resume(throwing: GatewayResponseError(
            method: "progressCard.get", code: "UNAVAILABLE", message: "Temporarily unavailable", details: nil))
        let denied = await wire.next("progressCard.get")
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil)?.revision == 1)
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:main:work","revision":4}"#.utf8))
        denied.reply.resume(throwing: GatewayResponseError(
            method: "progressCard.get",
            code: "INVALID_REQUEST",
            message: "Participation required",
            details: ["code": .init("SESSION_PARTICIPATION_REQUIRED")]))
        let afterDenial = await wire.next("progressCard.get")
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil) == nil)
        afterDenial.reply.resume(returning: self.empty)
        facts.disconnect()
        facts.unwatch(owner)
    }

    @Test func `replacement connections resubscribe active interests and reset discards prior cards`() async {
        let firstWire = HoverFactsWire()
        let replacement = HoverFactsWire()
        let facts = OpenClawChatSidebarHoverFacts()
        facts.connect { try await firstWire.send($0) }
        let owner = facts.watch(sessionKey: "agent:main:work", agentID: nil)
        let firstSubscription = await firstWire.next()
        firstSubscription.reply.resume(returning: self.acknowledged)
        let oldRead = await firstWire.next("progressCard.get")
        facts.connect { try await replacement.send($0) }
        let newSubscription = await replacement.next()
        newSubscription.reply.resume(returning: self.acknowledged)
        let newRead = await replacement.next("progressCard.get")
        await self.changed(facts, key: "agent:main:work") {
            newRead.reply.resume(returning: self.card("agent:main:work", revision: 3))
        }
        facts.receive(
            event: "progressCard.changed",
            payload: Data(#"{"sessionKey":"agent:main:work","revision":4}"#.utf8))
        let beforeReset = await replacement.next("progressCard.get")
        facts.receive(event: "sessions.changed", payload: Data(#"{"key":"agent:main:work","reason":"reset"}"#.utf8))
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil) == nil)
        let resetRead = await replacement.next("progressCard.get")
        oldRead.reply.resume(returning: self.card("agent:main:work", revision: 99))
        beforeReset.reply.resume(returning: self.card("agent:main:work", revision: 98))
        await self.changed(facts, key: "agent:main:work") {
            resetRead.reply.resume(returning: self.card("agent:main:work", revision: 4))
        }
        #expect(facts.progress(sessionKey: "agent:main:work", agentID: nil)?.revision == 4)
        facts.disconnect()
        facts.unwatch(owner)
    }
}
#endif

struct ChatSessionHoverCardDecodingTests {
    @Test func `retains channel origin from roster wire`() throws {
        let data = Data(
            (#"{"key":"agent:main:telegram:group:-42:topic:7","origin":{"provider":"telegram","# +
                #""label":"Release id:-42 topic:7","threadId":7},"chatType":"group","groupChannel":"Release","# +
                #""deliveryContext":{"channel":"telegram","accountId":"work","threadId":7}}"#)
                .utf8)
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(session)) as? [String: Any]
        let original = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        for key in ["origin", "chatType", "groupChannel", "deliveryContext"] {
            #expect(NSDictionary(dictionary: [key: encoded?[key] ?? NSNull()]) ==
                NSDictionary(dictionary: [key: original?[key] ?? NSNull()]))
        }
    }
}
