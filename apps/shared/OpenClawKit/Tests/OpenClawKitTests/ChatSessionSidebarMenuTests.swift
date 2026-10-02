#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
func sidebarMenuConnection(
    current: @escaping () -> Bool = { true }, local: Bool = false, selfProfileID: String? = nil,
    scopes: [String] = ["operator.admin"],
    request: @escaping (OpenClawChatGatewayRequest) async throws -> Data) throws -> OpenClawSessionMenuConnection
{
    var payload = try #require(JSONSerialization.jsonObject(with: Data(#"""
    {"type":"hello-ok","protocol":3,"server":{},
     "features":{"methods":["sessions.patch","sessions.assignOwner","users.list","users.self","chat.history"]},
     "snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},
     "auth":{"scopes":["operator.admin"]},"policy":{}}
    """#.utf8)) as? [String: Any])
    payload["auth"] = ["scopes": scopes]
    let hello = try JSONDecoder().decode(HelloOk.self, from: JSONSerialization.data(withJSONObject: payload))
    return OpenClawSessionMenuConnection(
        hello: hello,
        local: local,
        selfProfileID: selfProfileID,
        isCurrent: current,
        request: request,
        link: { _, _ in nil },
        openWindow: { _ in })
}

@MainActor
struct ChatSessionSidebarMenuTests {
    @Test func `appearance reset and involvement address the row incarnation and agent`() async throws {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:research:release-plan","sessionId":"durable-123","agentId":"stale-agent"}
        """#.utf8))
        var sent: [OpenClawChatGatewayRequest] = []
        let connection = try sidebarMenuConnection { request in
            sent.append(request)
            return Data(#"{"ok":true}"#.utf8)
        }
        try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
            "sessions.patch",
            session: session,
            fields: [
                "icon": .init(NSNull()),
                "color": .init(NSNull()),
            ]))
        try await connection.request(OpenClawChatGatewayRequests.sessionMenu(
            "sessions.setInvolvement",
            session: session,
            fields: [
                "hidden": .init(true),
                "expectedSessionId": .init(#require(session
                        .sessionId)),
            ]))
        let reset = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent[0].params)) as? NSDictionary
        #expect(reset == [
            "key": "agent:research:release-plan",
            "agentId": "research",
            "icon": NSNull(),
            "color": NSNull(),
            "expectedSessionId": "durable-123",
        ] as NSDictionary)
        let involvement = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sent[1].params)) as? NSDictionary
        #expect(involvement == [
            "key": "agent:research:release-plan",
            "agentId": "research",
            "expectedSessionId": "durable-123",
            "hidden": true,
        ] as NSDictionary)
    }

    @Test func `directory failure retains known human ownership and retry restores the roster`() async throws {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:research:release-plan","owner":{"actor":{"type":"human","id":"ada","label":"Ada"}}}
        """#.utf8))
        var failing = true
        let connection = try sidebarMenuConnection { request in
            if request.method == "users.self" {
                return Data(#"{"profile":{"id":"self","emails":[],"displayName":"Operator"}}"#.utf8)
            }
            if failing { throw URLError(.networkConnectionLost) }
            return Data(#"""
            {"profiles":[{"id":"self","emails":[]},{"id":"ada","emails":[],"displayName":"Ada"},
             {"id":"retired","emails":[],"mergedInto":"ada"}]}
            """#.utf8)
        }
        let actions = ChatSessionSidebarActions(connection: connection)
        await actions.refresh()?.value
        #expect(actions.owners(session: session, agents: []).map(\.key) == ["self", "ada"])
        #expect(actions.directoryError != nil)
        failing = false
        await actions.refresh()?.value
        #expect(actions.owners(session: session, agents: []).map(\.key) == ["self", "ada"])
        #expect(actions.directoryError == nil)
    }

    @Test func `stale menu reads coalesce directory and worktree refreshes`() async throws {
        let fixture = try SidebarMenuCacheFixture()
        let actions = ChatSessionSidebarActions(connection: fixture.connection)
        let now = ContinuousClock.now
        await actions.refresh(at: now)?.value
        let row = try fixture.row()
        #expect(actions.owners(session: row, agents: [], at: now).map(\.key) == ["me", "ada"])
        #expect(actions.worktreePath(for: row, at: now) == "/work/first")
        #expect(fixture.methods.count == 3)
        fixture.version = 2
        let fresh = now.advanced(by: .seconds(59))
        #expect(actions.owners(session: row, agents: [], at: fresh).map(\.key) == ["me", "ada"])
        #expect(actions.worktreePath(for: row, at: fresh) == "/work/first")
        #expect(actions.refreshTask == nil)
        fixture.holdDirectory = true
        defer { fixture.releaseDirectory() }
        let stale = now.advanced(by: .seconds(61))
        #expect(actions.owners(session: row, agents: [], at: stale).map(\.key) == ["me", "ada"])
        let refresh = try #require(actions.refreshTask)
        var starts = fixture.directoryStarted.stream.makeAsyncIterator()
        _ = await starts.next()
        for _ in 0..<3 {
            #expect(actions.worktreePath(for: row, at: stale) == "/work/first")
            #expect(actions.owners(session: row, agents: [], at: stale).map(\.key) == ["me", "ada"])
        }
        let activationRefresh = actions.refresh(at: stale)
        fixture.releaseDirectory()
        await refresh.value
        await activationRefresh?.value
        #expect(fixture.methods.filter { $0 == "users.list" }.count == 2)
        #expect(fixture.methods.filter { $0 == "worktrees.list" }.count == 2)
        #expect(actions.owners(session: row, agents: [], at: stale).map(\.key) == ["me", "grace"])
        #expect(actions.worktreePath(for: row, at: stale) == "/work/second")
    }

    @Test func `failed menu refresh preserves good data until explicit retry succeeds`() async throws {
        let fixture = try SidebarMenuCacheFixture()
        let actions = ChatSessionSidebarActions(connection: fixture.connection)
        let now = ContinuousClock.now
        let row = try fixture.row()
        await actions.refresh(at: now)?.value
        fixture.failing = true
        await actions.refresh(at: now)?.value
        #expect(actions.directoryError != nil)
        for _ in 0..<3 {
            #expect(actions.owners(session: row, agents: [], at: now).map(\.key) == ["me", "ada"])
            #expect(actions.worktreePath(for: row, at: now) == "/work/first")
        }
        #expect(actions.refreshTask == nil)
        #expect(fixture.methods.count == 6)
        fixture.failing = false
        fixture.version = 2
        await actions.refresh(at: now)?.value
        #expect(actions.directoryError == nil)
        #expect(actions.owners(session: row, agents: [], at: now).map(\.key) == ["me", "grace"])
        #expect(actions.worktreePath(for: row, at: now) == "/work/second")
    }

    @Test func `reconnect replaces menu data and cancels the prior refresh`() async throws {
        let first = try SidebarMenuCacheFixture()
        let second = try SidebarMenuCacheFixture()
        second.version = 2
        let commands = OpenClawChatWindowCommands()
        commands.setSessionMenuConnection(first.connection)
        let initialRefresh = try #require(commands.sessionMenuActions.refreshTask)
        await initialRefresh.value
        let retired = commands.sessionMenuActions
        first.holdDirectory = true
        defer { first.releaseDirectory() }
        let pending = try #require(retired.refresh())
        var starts = first.directoryStarted.stream.makeAsyncIterator()
        _ = await starts.next()
        first.current = false
        commands.setSessionMenuConnection(second.connection)
        let replacement = commands.sessionMenuActions
        #expect(replacement !== retired)
        #expect(pending.isCancelled)
        let newRefresh = try #require(replacement.refreshTask)
        first.releaseDirectory()
        await pending.value
        await newRefresh.value
        #expect(try replacement.owners(session: second.row(), agents: []).map(\.key) == ["me", "grace"])
        #expect(try replacement.worktreePath(for: second.row()) == "/work/second")
        #expect(first.methods.filter { $0 == "worktrees.list" }.count == 1)
        commands.setSessionMenuConnection(nil)
        #expect(commands.sessionMenuActions.connection == nil)
    }

    @Test func `retired connections reject mutations before dispatch and directory replies after dispatch`() async throws {
        var current = false
        var calls = 0
        let connection = try sidebarMenuConnection(current: { current }) { _ in
            calls += 1
            current = false
            return Data(#"{"profiles":[]}"#.utf8)
        }
        await #expect(throws: CancellationError.self) {
            try await connection.request(.init(method: "sessions.patch", timeoutMs: 15000))
        }
        #expect(calls == 0)
        current = true
        await #expect(throws: CancellationError.self) {
            let _: [String: [String]] = try await connection.read("users.list")
        }
        #expect(calls == 1)
    }

    @Test(arguments: ["cursor", "vscode", "windsurf", "zed"])
    func `editor URLs preserve local path segments`(_ editor: String) throws {
        let url = try #require(ChatSessionSidebarActions.editorURL(editor, path: "/work/release #1/a?b%20"))
        #expect(url.absoluteString == "\(editor)://file/work/release%20%231/a%3Fb%2520")
        #expect(ChatSessionSidebarActions.editorURL(editor, path: "relative/path") == nil)
        #expect(ChatSessionSidebarActions.editorURL("https", path: "/work/project") == nil)
    }

    @Test(arguments: [("🦞", true), (" 👩‍💻 ", true), ("🇦🇹", true), ("a", false), ("🦞🚀", false), ("", false)])
    func `custom emoji uses one bounded grapheme`(_ entry: (String, Bool)) {
        #expect(ChatSessionIconPicker.acceptsCustomEmoji(entry.0) == entry.1)
    }

    @Test(arguments: [(false, false, false), (true, false, false), (true, true, false), (true, false, true)])
    func `editor destinations require a live local worktree`(_ options: (Bool, Bool, Bool)) async throws {
        let (local, remoteNode, removed) = options
        var row: [String: Any] = ["key": "agent:research:thread", "worktree": ["id": "wt-1"]]
        if remoteNode { row["execNode"] = "other-machine" }
        let session = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: JSONSerialization.data(withJSONObject: row))
        var worktreeReads = 0
        let connection = try sidebarMenuConnection(local: local) { request in
            if request.method == "users.self" { return Data(#"{"profile":{"id":"me","emails":[]}}"#.utf8) }
            if request.method == "users.list" { return Data(#"{"profiles":[]}"#.utf8) }
            #expect(request.method == "worktrees.list")
            worktreeReads += 1
            var worktree: [String: Any] = [
                "id": "wt-1",
                "name": "working copy",
                "repoFingerprint": "repo-1",
                "repoRoot": "/work/repo",
                "path": "/work/copy",
                "branch": "feature",
                "baseRef": "main",
                "ownerKind": "session",
                "createdAt": 1,
                "lastActiveAt": 2,
            ]
            if removed { worktree["removedAt"] = 3 }
            return try JSONSerialization.data(withJSONObject: ["worktrees": [worktree]])
        }
        let actions = ChatSessionSidebarActions(connection: connection)
        await actions.refresh()?.value
        #expect(worktreeReads == (local ? 1 : 0))
        #expect(actions.worktreePath(for: session) == (local && !remoteNode && !removed ? "/work/copy" : nil))
    }

    @Test func `hello identity retains Me when profile refresh is unavailable`() async throws {
        let session = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"agent:research:thread"}"#.utf8))
        let connection = try sidebarMenuConnection(selfProfileID: "self") { request in
            if request.method == "users.self" { throw URLError(.networkConnectionLost) }
            return Data(#"{"profiles":[{"id":"self","emails":[]},{"id":"ada","emails":["ada@example.test"]}]}"#.utf8)
        }
        let actions = ChatSessionSidebarActions(connection: connection)
        await actions.refresh()?.value
        #expect(actions.owners(session: session, agents: []).map(\.key) == ["self", "ada"])
        #expect(actions.directoryError == nil)
    }

    @Test(arguments: [
        "operator.sessions.read",
        "operator.sessions.write",
        "operator.read",
        "operator.write",
        "operator.admin",
    ])
    func `Markdown accepts scoped reads without widening appearance writes`(_ scope: String) throws {
        let connection = try sidebarMenuConnection(scopes: [scope]) { _ in Data() }
        #expect(connection.allows("chat.history", scope: "operator.sessions.read"))
        #expect(connection.allows("sessions.patch") == ["operator.write", "operator.admin"].contains(scope))
    }

    @Test func `implicit home links stay groupable while explicit children do not`() throws {
        var row: [String: Any] = [
            "key": "agent:research:release-plan",
            "parentSessionKey": "agent:research:main",
            "createdVia": "operator",
            "spawnDepth": 0,
        ]
        func canGroup() throws -> Bool {
            let session = try JSONDecoder().decode(
                OpenClawChatSessionEntry.self,
                from: JSONSerialization.data(withJSONObject: row))
            return ChatSessionSidebarActions.canMoveToGroup(session, mainKeys: ["agent:research:main"])
        }
        #expect(try canGroup())
        row["parentSessionId"] = "explicit-parent"
        #expect(try !canGroup())
        row.removeValue(forKey: "parentSessionId")
        row["spawnedBy"] = "agent:research:main"
        #expect(try !canGroup())
        row.removeValue(forKey: "spawnedBy")
        row["key"] = "agent:research:subagent:run"
        #expect(try !canGroup())
    }
}

@MainActor
private final class SidebarMenuCacheFixture {
    var current = true
    var failing = false
    var version = 1
    var holdDirectory = false
    var methods: [String] = []
    let directoryStarted = AsyncStream<Void>.makeStream()
    private var directoryWaiter: CheckedContinuation<Void, Never>?
    var connection: OpenClawSessionMenuConnection!

    init() throws {
        self.connection = try sidebarMenuConnection(current: { [unowned self] in self.current }, local: true) {
            [unowned self] request in
            self.methods.append(request.method)
            if request.method == "users.list", self.holdDirectory {
                await withCheckedContinuation { continuation in
                    self.directoryWaiter = continuation
                    self.directoryStarted.continuation.yield(())
                }
            }
            if self.failing { throw URLError(.networkConnectionLost) }
            switch request.method {
            case "users.self": return Data(#"{"profile":{"id":"me","emails":[]}}"#.utf8)
            case "users.list":
                let id = self.version == 1 ? "ada" : "grace"
                return Data(#"{"profiles":[{"id":"\#(id)","emails":[]}]}"#.utf8)
            case "worktrees.list":
                let path = self.version == 1 ? "/work/first" : "/work/second"
                return Data(
                    #"{"worktrees":[{"id":"copy","name":"copy","repoFingerprint":"repo","repoRoot":"/work/repo","path":"\#(path)","branch":"feature","baseRef":"main","ownerKind":"session","createdAt":1,"lastActiveAt":2}]}"#
                        .utf8)
            default: throw URLError(.unsupportedURL)
            }
        }
    }

    func row() throws -> OpenClawChatSessionEntry {
        try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
            #"{"key":"agent:research:launch","sessionId":"launch-id","worktree":{"id":"copy"}}"#.utf8))
    }

    func releaseDirectory() {
        self.holdDirectory = false
        self.directoryWaiter?.resume()
        self.directoryWaiter = nil
    }
}
#endif
