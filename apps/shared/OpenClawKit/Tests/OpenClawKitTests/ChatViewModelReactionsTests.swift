import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI
@testable import OpenClawKit

private actor ReactionRequestGate {
    private var entered = false
    private var released = false
    private var arrivals: [CheckedContinuation<Void, Never>] = []
    private var releaseContinuation: CheckedContinuation<Void, Never>?

    func wait() async {
        self.entered = true
        self.arrivals.forEach { $0.resume() }
        self.arrivals = []
        guard !self.released else { return }
        await withCheckedContinuation { self.releaseContinuation = $0 }
    }

    func waitForArrival() async {
        guard !self.entered else { return }
        await withCheckedContinuation { self.arrivals.append($0) }
    }

    func release() {
        self.released = true
        self.releaseContinuation?.resume()
        self.releaseContinuation = nil
    }
}

private actor ReactionTestTransport: OpenClawChatTransport {
    struct Write: Equatable {
        let sessionKey: String
        let agentID: String?
        let messageID: String
        let emoji: String
        let remove: Bool
    }

    enum Failure: LocalizedError {
        case rejected
        var errorDescription: String? {
            "Reaction was rejected"
        }
    }

    let access: OpenClawChatReactionAccess
    let listGate: ReactionRequestGate?
    let setGate: ReactionRequestGate?
    let setFails: Bool
    let listOmitsMessage: Bool
    let initial: [OpenClawChatReactionSummary]
    var routeID = UUID()
    private(set) var listCount = 0
    private(set) var writes: [Write] = []

    init(
        cap: String? = "write",
        listGate: ReactionRequestGate? = nil,
        setGate: ReactionRequestGate? = nil,
        setFails: Bool = false,
        listOmitsMessage: Bool = false,
        initial: [OpenClawChatReactionSummary] = [])
    {
        self.access = OpenClawChatReactionAccess(
            role: "operator", scopes: ["operator.write"], sessionCap: cap,
            methods: ["session.reactions.list", "session.reactions.set"], userID: "self")
        self.listGate = listGate
        self.setGate = setGate
        self.setFails = setFails
        self.listOmitsMessage = listOmitsMessage
        self.initial = initial
    }

    func acquireReactionsRouteLease() async -> OpenClawChatReactionsRouteLease? {
        let routeID = self.routeID
        return OpenClawChatReactionsRouteLease(
            routeID: routeID,
            access: self.access,
            isCurrent: { await self.isCurrent(routeID) },
            list: { key, _ in await self.list(key) },
            set: { key, agentID, messageID, emoji, remove in
                try await self.set(.init(
                    sessionKey: key, agentID: agentID, messageID: messageID, emoji: emoji, remove: remove))
            })
    }

    func rotateRoute() {
        self.routeID = UUID()
    }

    func isCurrent(_ routeID: UUID) -> Bool {
        self.routeID == routeID
    }

    private func list(_ key: String) async -> OpenClawChatReactionsListResult {
        self.listCount += 1
        if self.listCount == 1 { await self.listGate?.wait() }
        return .init(sessionID: "session-\(key)", reactions: self.listOmitsMessage ? [:] : ["saved": self.initial])
    }

    private func set(_ request: Write) async throws -> OpenClawChatReactionsSetResult {
        self.writes.append(request)
        if self.writes.count == 1 { await self.setGate?.wait() }
        if self.setFails { throw Failure.rejected }
        let reactions: [OpenClawChatReactionSummary] = request.remove ? [] : [
            .init(emoji: request.emoji, count: 1, identities: [.init(id: "self", label: "You")]),
        ]
        return .init(messageID: request.messageID, reactions: reactions)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: "session-\(sessionKey)", messages: [
            AnyCodable([
                "role": "user", "content": "Saved prompt", "timestamp": 1,
                "__openclaw": ["id": "saved"],
            ]),
            AnyCodable([
                "role": "assistant", "content": "Saved reply", "timestamp": 2,
                "__openclaw": ["id": "reply"],
            ]),
        ], thinkingLevel: "off")
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool, agentID _: String?) async throws
        -> OpenClawChatSessionsListResponse
    {
        let entries = ["agent:main:a", "agent:main:b"].map { key in
            var entry = OpenClawChatSessionEntry.placeholder(key: key)
            entry.agentId = "main"
            entry.sessionId = "session-\(key)"
            entry.sharingRole = .viewer
            entry.visibility = .shared
            return entry
        }
        return .init(ts: nil, path: nil, count: entries.count, defaults: nil, sessions: entries)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw Failure.rejected
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

@MainActor
private final class ReactionViewModelFixture {
    let suite = "ChatViewModelReactionsTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let model: OpenClawChatViewModel

    init(transport: ReactionTestTransport, sessionKey: String = "agent:main:a") {
        self.defaults = UserDefaults(suiteName: self.suite)!
        self.model = OpenClawChatViewModel(
            sessionKey: sessionKey, transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: self.defaults))
    }

    func load() async {
        self.model.load()
        await self.model.bootstrapTask?.value
        await self.model.reactionState.refreshTask?.value
    }

    func close() {
        self.model.detachTransport()
        self.defaults.removePersistentDomain(forName: self.suite)
    }
}

@MainActor
struct ChatViewModelReactionsTests {
    @Test(arguments: [
        ("owner", "shared", nil, true), ("admin", "draft", "write", true),
        ("owner", "draft", "view", true), ("member", "draft", nil, false),
        ("member", "read-only", "view", true), ("viewer", "shared", nil, true),
        ("viewer", "shared", "write", true), ("viewer", "shared", "suggest", false),
        ("viewer", "shared", "view", false), ("viewer", "suggest", "suggest", true),
        ("viewer", "suggest", nil, true), ("viewer", "suggest", "view", false),
        ("viewer", "read-only", "write", false), ("viewer", "draft", "write", false),
        ("owner", "shared", "none", false), ("admin", "draft", "none", false),
    ] as [(String, String, String?, Bool)])
    func `hello cap and session role follow the Control UI permission table`(
        role: String, visibility: String, cap: String?, allowed: Bool)
    {
        let access = self.access(cap: cap)
        #expect(access.canReact(sharingRole: role, visibility: visibility, archived: false, catalog: false) == allowed)
    }

    @Test func `reaction admission requires current advertised operator write authority`() {
        let denied = [
            self.access(role: "node"), self.access(role: nil), self.access(scopes: nil),
            self.access(scopes: []), self.access(scopes: ["operator.read"]),
            self.access(scopes: ["operator.sessions.write"]), self.access(methods: nil),
            self.access(methods: []),
        ]
        for access in denied {
            #expect(!access.canReact(sharingRole: "owner", visibility: "shared", archived: false, catalog: false))
        }
        #expect(self.access(scopes: ["operator.admin"]).canReact(
            sharingRole: "owner", visibility: nil, archived: false, catalog: false))
        #expect(!self.access().canReact(sharingRole: nil, visibility: "shared", archived: false, catalog: false))
        #expect(!self.access().canReact(sharingRole: "owner", visibility: "shared", archived: true, catalog: false))
        #expect(!self.access().canReact(sharingRole: "owner", visibility: "shared", archived: false, catalog: true))
    }

    @Test(arguments: ["none", "view", "suggest", "write"])
    func `operator hello JSON delivers session cap into route access facts`(cap: String) throws {
        struct Response: Decodable { let payload: HelloOk }
        let response = Data("""
        {
          "type": "res", "id": "connect", "ok": true,
          "payload": {
            "type": "hello-ok", "protocol": 3,
            "server": {"version": "test", "connId": "reaction-fixture"},
            "features": {"methods": ["session.reactions.list", "session.reactions.set"]},
            "snapshot": {"presence": [], "health": {},
              "stateVersion": {"presence": 0, "health": 0}, "uptimeMs": 0},
            "auth": {"role": "operator", "scopes": ["operator.write"], "sessionCap": "\(cap)"},
            "policy": {"maxPayload": 1, "maxBufferedBytes": 1, "tickIntervalMs": 30000}
          }
        }
        """.utf8)
        let hello = try JSONDecoder().decode(Response.self, from: response).payload
        let access = GatewayReactionAccessFacts(hello: hello)
        #expect(access.sessionCap == cap)
        #expect(access.role == "operator")
        #expect(access.scopes == ["operator.write"])
        #expect(access.methods?.contains("session.reactions.set") == true)
    }

    @Test func `list snapshots preserve later events and ignore other session identities`() async throws {
        let gate = ReactionRequestGate()
        let old = self.summary("👍", identity: "someone")
        let fixture = ReactionViewModelFixture(transport: .init(listGate: gate, initial: [old]))
        defer { fixture.close() }
        fixture.model.load()
        await fixture.model.bootstrapTask?.value
        await gate.waitForArrival()
        let read = fixture.model.reactionState.refreshTask
        let prompt = try #require(fixture.model.messages.first)
        let recent = self.summary("🎉", identity: "self")
        fixture.model.handleTransportEvent(.sessionReaction(self.event(reactions: [recent])))
        fixture.model.handleTransportEvent(.sessionReaction(self.event(sessionKey: "agent:main:b", reactions: [old])))
        fixture.model.handleTransportEvent(.sessionReaction(self.event(agentID: "other", reactions: [old])))
        fixture.model.handleTransportEvent(.sessionReaction(self.event(sessionID: "old-transcript", reactions: [old])))
        #expect(fixture.model.messageReactions(for: prompt) == [recent])
        await gate.release()
        await read?.value
        #expect(fixture.model.messageReactions(for: prompt) == [recent])
        fixture.model.handleTransportEvent(.sessionReaction(self.event(reactions: [])))
        #expect(fixture.model.messageReactions(for: prompt).isEmpty)
    }

    @Test func `own reactions toggle and events outrank pending write responses`() async throws {
        let gate = ReactionRequestGate()
        let own = self.summary("👍", identity: "self")
        let transport = ReactionTestTransport(setGate: gate, initial: [own])
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        #expect(fixture.model.canReact(to: prompt))
        #expect(fixture.model.viewerReactionUserID == "self")
        let write = Task { await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍") }
        await gate.waitForArrival()
        #expect(fixture.model.isReactionPending(for: prompt, emoji: "👍"))
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍")
        #expect(await transport.writes.count == 1)
        let newer = self.summary("👀", identity: "someone")
        fixture.model.handleTransportEvent(.sessionReaction(self.event(reactions: [newer])))
        await gate.release()
        await write.value
        #expect(fixture.model.messageReactions(for: prompt) == [newer])
        #expect(!fixture.model.isReactionPending(for: prompt, emoji: "👍"))
        #expect(await transport.writes.first == .init(
            sessionKey: "agent:main:a", agentID: "main", messageID: "saved", emoji: "👍", remove: true))
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "🚀")
        #expect(fixture.model.messageReactions(for: prompt) == [self.summary("🚀", identity: "self")])
    }

    @Test(arguments: [false, true])
    func `independent emoji writes stay FIFO after success or failure`(setFails: Bool) async throws {
        let gate = ReactionRequestGate()
        let transport = ReactionTestTransport(
            setGate: gate, setFails: setFails, initial: [self.summary("🎉", identity: "self")])
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let first = await self.startReaction(fixture.model, message: prompt, emoji: "👍")
        await gate.waitForArrival()
        let second = await self.startReaction(fixture.model, message: prompt, emoji: "🎉")
        let third = await self.startReaction(fixture.model, message: prompt, emoji: "🚀")
        #expect(fixture.model.isReactionPending(for: prompt, emoji: "👍"))
        #expect(fixture.model.isReactionPending(for: prompt, emoji: "🎉"))
        #expect(fixture.model.isReactionPending(for: prompt, emoji: "🚀"))
        #expect(!fixture.model.isReactionPending(for: prompt, emoji: "👀"))
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍")
        #expect(await transport.writes.map(\.emoji) == ["👍"])
        fixture.model.handleTransportEvent(.sessionReaction(self.event(reactions: [])))
        await gate.release()
        await first.value
        await second.value
        await third.value
        #expect(await transport.writes == [
            .init(sessionKey: "agent:main:a", agentID: "main", messageID: "saved", emoji: "👍", remove: false),
            .init(sessionKey: "agent:main:a", agentID: "main", messageID: "saved", emoji: "🎉", remove: true),
            .init(sessionKey: "agent:main:a", agentID: "main", messageID: "saved", emoji: "🚀", remove: false),
        ])
    }

    @Test(arguments: [false, true])
    func `an applied list snapshot outranks a late set response including omitted messages`(
        omitsMessage: Bool) async throws
    {
        let listGate = ReactionRequestGate()
        let setGate = ReactionRequestGate()
        let listed = self.summary("👀", identity: "someone")
        let transport = ReactionTestTransport(
            listGate: listGate, setGate: setGate, listOmitsMessage: omitsMessage, initial: [listed])
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        fixture.model.load()
        await fixture.model.bootstrapTask?.value
        await listGate.waitForArrival()
        let read = fixture.model.reactionState.refreshTask
        let prompt = try #require(fixture.model.messages.first)
        let write = await self.startReaction(fixture.model, message: prompt, emoji: "👍")
        await setGate.waitForArrival()
        await listGate.release()
        await read?.value
        let expected = omitsMessage ? [] : [listed]
        #expect(fixture.model.messageReactions(for: prompt) == expected)
        await setGate.release()
        await write.value
        #expect(fixture.model.messageReactions(for: prompt) == expected)
    }

    @Test func `switching sessions retires queued writes without blocking the new session`() async throws {
        let gate = ReactionRequestGate()
        let transport = ReactionTestTransport(setGate: gate)
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let first = await self.startReaction(fixture.model, message: prompt, emoji: "👍")
        await gate.waitForArrival()
        let queued = await self.startReaction(fixture.model, message: prompt, emoji: "🎉")
        fixture.model.switchSession(to: "agent:main:b")
        await fixture.model.bootstrapTask?.value
        await fixture.model.reactionState.refreshTask?.value
        let nextPrompt = try #require(fixture.model.messages.first)
        let current = await self.startReaction(fixture.model, message: nextPrompt, emoji: "🚀")
        await current.value
        let expected: [ReactionTestTransport.Write] = [
            .init(sessionKey: "agent:main:a", agentID: "main", messageID: "saved", emoji: "👍", remove: false),
            .init(sessionKey: "agent:main:b", agentID: "main", messageID: "saved", emoji: "🚀", remove: false),
        ]
        #expect(await transport.writes == expected)
        await gate.release()
        await first.value
        await queued.value
        #expect(await transport.writes == expected)
        #expect(fixture.model.reactionError(for: nextPrompt) == nil)
    }

    @Test(arguments: [false, true])
    func `stale write success and failure cannot cross a session switch`(fails: Bool) async throws {
        let gate = ReactionRequestGate()
        let transport = ReactionTestTransport(setGate: gate, setFails: fails)
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let write = Task { await fixture.model.toggleMessageReaction(message: prompt, emoji: "🎉") }
        await gate.waitForArrival()
        fixture.model.switchSession(to: "agent:main:b")
        await fixture.model.bootstrapTask?.value
        await fixture.model.reactionState.refreshTask?.value
        let nextPrompt = try #require(fixture.model.messages.first)
        await gate.release()
        await write.value
        #expect(fixture.model.sessionKey == "agent:main:b")
        #expect(fixture.model.messageReactions(for: nextPrompt).isEmpty)
        #expect(fixture.model.reactionError(for: nextPrompt) == nil)
        #expect(!fixture.model.isReactionPending(for: nextPrompt, emoji: "🎉"))
    }

    @Test func `a new transcript instance invalidates writes before its session row refreshes`() async throws {
        let gate = ReactionRequestGate()
        let transport = ReactionTestTransport(setGate: gate, initial: [self.summary("👀", identity: "someone")])
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let write = Task { await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍") }
        await gate.waitForArrival()
        let original = try await transport.requestHistory(sessionKey: fixture.model.sessionKey)
        let replacement = OpenClawChatHistoryPayload(
            sessionKey: fixture.model.sessionKey, sessionId: "replacement-transcript",
            messages: original.messages, thinkingLevel: "off")
        #expect(fixture.model.applyHistoryPayload(
            replacement, for: fixture.model.beginHistoryRequest(), preservingOptimisticLocalMessages: false))
        #expect(fixture.model.messageReactions(for: prompt).isEmpty)
        #expect(!fixture.model.canReact(to: prompt))
        await gate.release()
        await write.value
        #expect(fixture.model.messageReactions(for: prompt).isEmpty)
        #expect(fixture.model.reactionError(for: prompt) == nil)
    }

    @Test func `failed current writes stay on their message and disconnect clears the error`() async throws {
        let transport = ReactionTestTransport(setFails: true)
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let reply = try #require(fixture.model.messages.last)
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍")
        #expect(fixture.model.reactionError(for: prompt) == "Reaction was rejected")
        #expect(fixture.model.reactionError(for: reply) == nil)
        #expect(!fixture.model.isReactionPending(for: prompt, emoji: "👍"))
        fixture.model.handleTransportEvent(.health(ok: false))
        #expect(fixture.model.reactionError(for: prompt) == nil)
        #expect(!fixture.model.canReact(to: prompt))
    }

    @Test func `saved prompts and replies use live role metadata while optimistic rows stay unavailable`() async throws {
        let fixture = ReactionViewModelFixture(transport: .init())
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let reply = try #require(fixture.model.messages.last)
        #expect(fixture.model.canReact(to: prompt))
        #expect(fixture.model.canReact(to: reply))
        let optimistic = OpenClawChatMessage(role: "user", content: [], timestamp: nil)
        fixture.model.appendMessage(optimistic)
        #expect(!fixture.model.canReact(to: optimistic))
        fixture.model.invalidateSessionMetadataReadiness()
        #expect(!fixture.model.canReact(to: prompt))
        await fixture.model.fetchSessions(limit: nil)
        #expect(fixture.model.canReact(to: prompt))
        fixture.model.messages.removeAll { $0.transcriptMessageID == "saved" }
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍")
        #expect(!fixture.model.canReact(to: prompt))
    }

    @Test(arguments: ["view", "none"])
    func `view-only operators retain chips without reaction controls`(cap: String) async throws {
        let existing = self.summary("❤️", identity: "someone")
        let transport = ReactionTestTransport(cap: cap, initial: [existing])
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        #expect(fixture.model.messageReactions(for: prompt) == [existing])
        #expect(!fixture.model.canReact(to: prompt))
        await fixture.model.toggleMessageReaction(message: prompt, emoji: "❤️")
        #expect(await transport.writes.isEmpty)
    }

    @Test func `reconnect resets access and ignores responses from the previous route`() async throws {
        let gate = ReactionRequestGate()
        let transport = ReactionTestTransport(setGate: gate)
        let fixture = ReactionViewModelFixture(transport: transport)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        let oldContext = fixture.model.reactionContextID
        let write = Task { await fixture.model.toggleMessageReaction(message: prompt, emoji: "👍") }
        await gate.waitForArrival()
        fixture.model.handleTransportEvent(.health(ok: false))
        await transport.rotateRoute()
        fixture.model.handleTransportEvent(.health(ok: true))
        await fixture.model.reactionState.refreshTask?.value
        #expect(fixture.model.reactionContextID != oldContext)
        #expect(fixture.model.canReact(to: prompt))
        await gate.release()
        await write.value
        #expect(fixture.model.messageReactions(for: prompt).isEmpty)
        #expect(fixture.model.reactionError(for: prompt) == nil)
        #expect(await transport.listCount == 2)
    }

    @Test(arguments: ["catalog:source:host:thread", "agent:main:catalog:source:host:thread"])
    func `catalog transcripts never load or expose native reactions`(key: String) async throws {
        let transport = ReactionTestTransport()
        let fixture = ReactionViewModelFixture(transport: transport, sessionKey: key)
        defer { fixture.close() }
        await fixture.load()
        let prompt = try #require(fixture.model.messages.first)
        #expect(!fixture.model.canReact(to: prompt))
        #expect(await transport.listCount == 0)
    }

    @Test(arguments: ["👍", "❤️", "🎉", "👀", "🚀", "😂", "👍🏽", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇦🇹", "1️⃣", "#⃣"])
    func `the custom picker accepts one Gateway emoji grapheme`(emoji: String) {
        #expect(OpenClawChatReactionEmoji.isValid(emoji))
    }

    @Test(arguments: ["", "a", "1", " ", "👍 ", " 👍", "👍\n", "👍👍", "🇦", "🏽", "👍a", "1️"])
    func `the custom picker rejects text multiple emoji and incomplete sequences`(text: String) {
        #expect(!OpenClawChatReactionEmoji.isValid(text))
    }

    private func startReaction(
        _ model: OpenClawChatViewModel,
        message: OpenClawChatMessage,
        emoji: String) async -> Task<Void, Never>
    {
        let (started, continuation) = AsyncStream<Void>.makeStream()
        let task = Task {
            continuation.yield(())
            continuation.finish()
            await model.toggleMessageReaction(message: message, emoji: emoji)
        }
        var iterator = started.makeAsyncIterator()
        _ = await iterator.next()
        return task
    }

    private func access(
        role: String? = "operator", scopes: Set<String>? = ["operator.write"], cap: String? = nil,
        methods: Set<String>? = ["session.reactions.set"]) -> OpenClawChatReactionAccess
    {
        .init(role: role, scopes: scopes, sessionCap: cap, methods: methods)
    }

    private func summary(_ emoji: String, identity: String) -> OpenClawChatReactionSummary {
        .init(emoji: emoji, count: 1, identities: [.init(id: identity, label: identity == "self" ? "You" : "Sam")])
    }

    private func event(
        sessionKey: String = "agent:main:a", agentID: String = "main",
        sessionID: String = "session-agent:main:a",
        reactions: [OpenClawChatReactionSummary]) -> OpenClawChatReactionEvent
    {
        .init(sessionKey: sessionKey, agentID: agentID, sessionID: sessionID, messageID: "saved", reactions: reactions)
    }
}
