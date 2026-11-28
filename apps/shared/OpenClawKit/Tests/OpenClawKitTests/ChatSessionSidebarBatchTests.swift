#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarBatchTests {
    private func connection(
        scopes: [String] = ["operator.admin"],
        personal: Bool = true,
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data) throws -> OpenClawSessionMenuConnection
    {
        let hello = try JSONDecoder().decode(HelloOk.self, from: JSONSerialization.data(withJSONObject: [
            "type": "hello-ok", "protocol": 3, "server": [:],
            "features": ["capabilities": personal ? ["personal-session-pins"] : [], "methods": [
                "config.get",
                "sessions.patch",
                "sessions.patchMany",
                "sessions.delete",
                "sessions.groups.list",
                "sessions.groups.put",
                "users.prefs.get",
                "users.prefs.set",
            ]],
            "snapshot": ["presence": [], "health": [:], "stateVersion": ["presence": 0, "health": 0], "uptimeMs": 0],
            "auth": ["scopes": scopes], "policy": [:],
        ]))
        return .init(
            hello: hello,
            local: false,
            isCurrent: { true },
            request: request,
            link: { _, _ in nil },
            openWindow: { _ in })
    }

    private func row(_ index: Int, fields: [String: Any] = [:]) throws -> OpenClawChatSessionEntry {
        let wire: [String: Any] = ["key": "agent:bulk:thread-\(index)", "sessionId": "id-\(index)", "agentId": "old"]
        return try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: JSONSerialization.data(
            withJSONObject: wire.merging(fields) { _, value in value }))
    }

    private func params(_ request: OpenClawChatGatewayRequest) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
    }

    private func pinSnapshot(_ entries: [String]) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "status": "ok", "entries": ["ui.railShortcuts": entries],
        ])
    }

    private func pinPatch(_ request: OpenClawChatGatewayRequest) throws -> [String] {
        let params = try self.params(request)
        #expect(request.method == "users.prefs.set")
        #expect(Set(params.keys) == ["entries", "expectedEntries"])
        let prefs = try #require(params["entries"] as? [String: [String]])
        #expect(Set(prefs.keys) == ["ui.railShortcuts"])
        return try #require(prefs["ui.railShortcuts"])
    }

    @Test func `old Gateway displays its saved B then A order without a private read or shared write`() async throws {
        var methods: [String] = []
        let connection = try self.connection(personal: false) { request in
            methods.append(request.method)
            return Data(#"{"valid":true,"config":{"ui":{"prefs":{"sidebarEntries":["session:b","session:a"]}}}}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.refreshPins(connection)
        #expect(batch.sidebarEntries == ["session:b", "session:a"])
        await #expect(throws: OpenClawPersonalPinError.self) {
            try await batch.movePin(key: "a", target: "b", after: false, connection: connection)
        }
        #expect(methods == ["config.get"])
    }

    @Test func `pin reordering permutes session slots without changing foreign bytes or positions`() throws {
        let entries = [
            "route:usage",
            "session:a",
            "plugin: odd\tname",
            "session:b",
            "future:e\u{301}",
            "session:c",
            "session:",
            "",
        ]
        let moved = try ChatSessionSidebarBatch.movingPin(
            entries.map(AnyCodable.init),
            key: "c",
            target: "a",
            after: false).compactMap { $0.value as? String }
        #expect(moved == [
            "route:usage",
            "session:c",
            "plugin: odd\tname",
            "session:a",
            "future:e\u{301}",
            "session:b",
            "session:",
            "",
        ])
        for index in [0, 2, 4, 6, 7] {
            #expect(Array(moved[index].utf8) == Array(entries[index].utf8))
        }
    }

    @Test func `a self move is already satisfied only if its pin still exists`() throws {
        let entries = ["session:a", "route:usage", "session-rail:b"].map(AnyCodable.init)
        #expect(try ChatSessionSidebarBatch.movingPin(entries, key: "a", target: "a", after: true) == entries)
        #expect(throws: OpenClawPersonalPinError.placementChanged) {
            try ChatSessionSidebarBatch.movingPin(entries, key: "b", target: "b", after: true)
        }
    }

    @Test func `reorder preserves heterogeneous layout values and compares their exact JSON`() async throws {
        let original: [Any] = ["session:a  ", 7, NSNull(), ["future": [true, false]], "session:b"]
        var server = original
        var writes = 0
        let conn = try self.connection { request in
            if request.method == "users.prefs.get" {
                return try JSONSerialization.data(withJSONObject: [
                    "status": "ok",
                    "entries": ["ui.railShortcuts": server],
                ])
            }
            let wire = try self.params(request)
            let expected = try #require((wire["expectedEntries"] as? [String: [Any]])?["ui.railShortcuts"])
            let next = try #require((wire["entries"] as? [String: [Any]])?["ui.railShortcuts"])
            #expect(NSArray(array: expected).isEqual(to: original))
            #expect(NSArray(array: next).isEqual(to: [
                "session:b",
                7,
                NSNull(),
                ["future": [true, false]],
                "session:a  ",
            ]))
            server = next
            writes += 1
            return Data(#"{"status":"ok"}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.movePin(key: "b", target: "a", after: false, connection: conn)
        #expect(writes == 1)
        #expect(batch.sidebarEntries == ["session:b", "session:a  "])
        #expect(batch.pinPositions == ["b": 0, "a": 1])
    }

    @Test(arguments: [false, true])
    func `a failed write or conflict reread restores the last confirmed pin order`(conflict: Bool) async throws {
        let entries = ["session:a", "future:reserved", "session:b"]
        let batch = ChatSessionSidebarBatch()
        let failure = URLError(.cannotConnectToHost)
        var methods: [String] = []
        let connection = try self.connection { request in
            methods.append(request.method)
            if request.method == "users.prefs.get" {
                if methods.count == 1 { return try self.pinSnapshot(entries) }
                #expect(batch.sidebarEntries == entries)
                throw failure
            }
            #expect(batch.sidebarEntries == ["session:b", "future:reserved", "session:a"])
            #expect(try self.pinPatch(request) == batch.sidebarEntries)
            #expect(try self.params(request)["expectedEntries"] as? [String: [String]] == ["ui.railShortcuts": entries])
            if conflict { return Data(#"{"status":"conflict"}"#.utf8) }
            throw failure
        }
        await #expect(throws: failure) {
            try await batch.movePin(key: "b", target: "a", after: false, connection: connection)
        }
        #expect(methods == ["users.prefs.get", "users.prefs.set"] + (conflict ? ["users.prefs.get"] : []))
        #expect(batch.sidebarEntries == entries)
        #expect(batch.notices == [failure.localizedDescription])
    }

    @Test func `changing a roster filter cannot strand a failed optimistic preference write`() async throws {
        let entries = ["session:a", "route:home", "session:b"]
        let batch = ChatSessionSidebarBatch()
        let connection = try self.connection { request in
            if request.method == "users.prefs.get" { return try self.pinSnapshot(entries) }
            batch.reset(clearConnection: false)
            throw URLError(.cannotConnectToHost)
        }
        await #expect(throws: URLError.self) {
            try await batch.movePin(key: "b", target: "a", after: false, connection: connection)
        }
        #expect(batch.sidebarEntries == entries)
    }

    @Test(arguments: ["users.prefs.get", "users.prefs.set"])
    func `a late read or conflict cannot replace a new scope's optimistic order`(lateMethod: String) async throws {
        let batch = ChatSessionSidebarBatch()
        let paused = AsyncStream.makeStream(of: CheckedContinuation<Void, Never>.self)
        var oldMethods: [String] = []
        let old = try self.connection { request in
            if request.method == lateMethod, !oldMethods.contains(lateMethod) {
                await withCheckedContinuation { paused.continuation.yield($0) }
            }
            oldMethods.append(request.method)
            if request.method == "users.prefs.set" { return Data(#"{"status":"conflict"}"#.utf8) }
            return try self.pinSnapshot(["session:a", "session:b"])
        }
        var server = ["session:c", "session:d"]
        let current = try self.connection { request in
            if request.method == "users.prefs.set" {
                await withCheckedContinuation { paused.continuation.yield($0) }
                server = try self.pinPatch(request)
                return Data(#"{"status":"ok"}"#.utf8)
            }
            return try self.pinSnapshot(server)
        }
        var iterator = paused.stream.makeAsyncIterator()
        let first = Task {
            try await batch.movePin(key: "b", target: "a", after: false, connection: old)
        }
        let oldReply = try #require(await iterator.next())
        batch.reset()
        let second = Task {
            try await batch.movePin(key: "d", target: "c", after: false, connection: current)
        }
        let currentWrite = try #require(await iterator.next())
        oldReply.resume()
        try await first.value
        #expect(oldMethods == (lateMethod == "users.prefs.get" ? [lateMethod] : ["users.prefs.get", lateMethod]))
        #expect(batch.busy)
        #expect(batch.sidebarEntries == ["session:d", "session:c"])
        #expect(batch.notices.isEmpty)
        currentWrite.resume()
        try await second.value
        #expect(!batch.busy)
        #expect(server == batch.sidebarEntries)
        paused.continuation.finish()
    }

    @Test func `concurrent preference writers trigger a fresh guarded move preserving their entries`() async throws {
        var server = ["route:home", "session:a", "plugin:old", "session:b"]
        let remote = ["route:home", "session:a", "future:new", "session:b", "plugin:new", "route:tail"]
        var observations: [[String]] = []
        let connection = try self.connection(scopes: ["operator.write"]) { request in
            if request.method == "users.prefs.get" { return try self.pinSnapshot(server) }
            let expected = try #require(self.params(request)["expectedEntries"] as? [String: [String]])
            let previous = try #require(expected["ui.railShortcuts"])
            observations.append(previous)
            if observations.count == 1 { server = remote }
            guard previous == server else { return Data(#"{"status":"conflict"}"#.utf8) }
            server = try self.pinPatch(request)
            return Data(#"{"status":"ok"}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.movePin(key: "b", target: "a", after: false, connection: connection)
        #expect(observations == [["route:home", "session:a", "plugin:old", "session:b"], remote])
        #expect(batch.sidebarEntries == [
            "route:home",
            "session:b",
            "future:new",
            "session:a",
            "plugin:new",
            "route:tail",
        ])
        #expect(server == batch.sidebarEntries)
    }

    @Test(arguments: ["a", "b"], [false, true])
    func `a vanished source or target refuses the reorder`(source: String, conflict: Bool) async throws {
        let remaining = ["session:a", "session-rail:b", "session:c", "session:d"]
        var server = conflict ? remaining + ["session:b"] : remaining
        var attempts = 0
        let connection = try self.connection { request in
            if request.method == "users.prefs.get" { return try self.pinSnapshot(server) }
            let next = try self.pinPatch(request)
            attempts += 1
            if conflict, attempts == 1 {
                server = remaining // The other client removed B before this CAS reached the Gateway.
                return Data(#"{"status":"conflict"}"#.utf8)
            }
            server = next
            return Data(#"{"status":"ok"}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        // An already-satisfied named move needs neither a write nor a warning.
        try await batch.movePin(key: "c", target: "d", after: false, connection: connection)
        #expect(attempts == 0)
        #expect(batch.notices.isEmpty)

        let target = source == "a" ? "b" : "a"
        await #expect(throws: OpenClawPersonalPinError.placementChanged) {
            try await batch.movePin(key: source, target: target, after: false, connection: connection)
        }
        #expect(batch.notices == [String(localized: "Pin placement changed. Refresh the list and retry.")])
        #expect(attempts == (conflict ? 1 : 0))
        #expect(server == remaining)
        #expect(batch.sidebarEntries == remaining)

        // Dropping on the section, rather than on B, still means after the last pin.
        try await batch.movePin(key: "a", target: nil, after: false, connection: connection)
        #expect(server == ["session:c", "session-rail:b", "session:d", "session:a"])
        #expect(batch.sidebarEntries == server)
    }

    enum Refresh: CaseIterable { case newerOrder, unavailable, reset }

    @Test(arguments: Refresh.allCases)
    func `an acknowledged move survives a lost refresh but yields to a newer order or connection`(
        refresh: Refresh) async throws
    {
        let before = ["session:a", "route:home", "session:b"]
        let accepted = ["session:b", "route:home", "session:a"]
        let external = ["session:a", "route:home", "session:b", "future:added"]
        let batch = ChatSessionSidebarBatch()
        var methods: [String] = []
        let connection = try self.connection { request in
            methods.append(request.method)
            if methods.count == 1 { return try self.pinSnapshot(before) }
            if request.method == "users.prefs.set" {
                #expect(try self.pinPatch(request) == accepted)
                return Data(#"{"status":"ok"}"#.utf8)
            }
            if refresh == .unavailable { throw URLError(.timedOut) }
            if refresh == .reset { batch.reset() }
            return try self.pinSnapshot(external)
        }
        do {
            try await batch.movePin(key: "b", target: "a", after: false, connection: connection)
        } catch { Issue.record("An acknowledged drop was reported as failed: \(error)") }
        #expect(methods == ["users.prefs.get", "users.prefs.set", "users.prefs.get"])
        #expect(batch.notices.isEmpty)
        // A lost refresh must not disable pin edits for the unchanged signed-in profile.
        #expect(connection.pinProfile.verified)
        switch refresh {
        case .newerOrder: #expect(batch.sidebarEntries == external)
        case .unavailable: #expect(batch.sidebarEntries == accepted)
        case .reset: #expect(batch.sidebarEntries.isEmpty)
        }
    }

    @Test func `missing and empty personal preferences are read without writing shared navigation`() async throws {
        let batch = ChatSessionSidebarBatch()
        let empty = try self.connection { request in
            #expect(request.method == "users.prefs.get")
            #expect(try self.params(request)["keys"] as? [String] == ["ui.railShortcuts"])
            return try self.pinSnapshot([])
        }
        let fresh = try self.connection { request in
            #expect(request.method == "users.prefs.get")
            return Data(#"{"status":"ok","entries":{}}"#.utf8)
        }
        try await batch.refreshPins(fresh)
        #expect(batch.sidebarEntries == ["route:cron", "route:plugins", "route:usage"])
        try await batch.refreshPins(empty)
        #expect(batch.sidebarEntries.isEmpty)
    }

    @Test func `batch deletion resolves optional run facts before dispatch`() async throws {
        var deleted: [String] = []
        let connection = try self.connection { request in
            let key = try #require(self.params(request)["key"] as? String)
            deleted.append(key)
            return try JSONSerialization.data(withJSONObject: [
                "ok": true, "key": key, "deleted": true, "archived": [],
            ])
        }
        let batch = ChatSessionSidebarBatch()
        for status in ["running", "queued"] {
            let active = try self.row(0, fields: ["status": status])
            #expect(await batch.run(.delete, rows: [active], mainKey: "main", connection: connection).isEmpty)
        }
        #expect(deleted.isEmpty)
        let idle = try self.row(1, fields: ["status": "running", "hasActiveRun": false])
        let terminal = try self.row(2, fields: ["status": "done", "hasActiveRun": true])
        let archived = try self.row(3, fields: ["status": "running", "hasActiveRun": true, "archived": true])
        let deletable = [idle, terminal, archived]
        #expect(await batch.run(.delete, rows: deletable, mainKey: "main", connection: connection) == deletable)
        #expect(deleted.sorted() == deletable.map(\.key))
    }

    @Test func `batch deletion keeps same-named archived sessions bound to their owning agents`() async throws {
        let research = try self.row(
            0,
            fields: ["key": "global", "agentId": "research", "sessionId": "research-global", "archived": true])
        let ops = try self.row(
            1,
            fields: ["key": "global", "agentId": "ops", "sessionId": "ops-global", "archived": true])
        var targets: [String] = []
        let connection = try self.connection { request in
            let params = try self.params(request)
            let agent = try #require(params["agentId"] as? String)
            targets.append(agent)
            #expect(params["expectedSessionId"] as? String == "\(agent)-global")
            if agent == "ops" { throw URLError(.cannotConnectToHost) }
            return Data(#"{"ok":true,"key":"global","deleted":true,"archived":[]}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        let deleted = await batch.run(.delete, rows: [research, ops], mainKey: "main", connection: connection)
        #expect(targets.sorted() == ["ops", "research"])
        #expect(deleted == [research])
        #expect(batch.errors.count == 1)
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(ops)] != nil)
    }

    @Test func `missing personal identity clears the old display and refuses a drag without a write`() async throws {
        let batch = ChatSessionSidebarBatch()
        let initial = try self.connection { _ in try self.pinSnapshot(["session:a"]) }
        try await batch.refreshPins(initial)
        #expect(batch.sidebarEntries == ["session:a"])
        var methods: [String] = []
        let profileless = try self.connection { request in
            methods.append(request.method)
            return Data(#"{"status":"no_durable_identity"}"#.utf8)
        }
        try await batch.refreshPins(profileless)
        #expect(batch.sidebarEntries.isEmpty)
        await #expect(throws: URLError(.userAuthenticationRequired)) {
            try await batch.movePin(key: "a", target: nil, after: false, connection: profileless)
        }
        #expect(methods == ["users.prefs.get", "users.prefs.get"])

        let malformed = try self.connection { _ in Data(#"{"status":"ok"}"#.utf8) }
        await #expect(throws: CocoaError.self) { try await batch.refreshPins(malformed) }
    }

    @Test func `native range and toggle proposals keep only visible roots while plain child clicks navigate`() {
        var selection = ChatSidebarSelection()
        let roots: Set = ["pin", "release-plan", "ops"]
        #expect(selection.update(["pin", "release-plan", "child", "ops"], roots: roots, multiple: true) == nil)
        #expect(selection.keys == roots)
        #expect(selection.update(["pin", "ops", "hidden"], roots: roots, multiple: true) == nil)
        #expect(selection.keys == ["pin", "ops"])
        #expect(selection.update(["child"], roots: roots, multiple: false) == "child")
        #expect(selection.keys.isEmpty)
        #expect(!selection.active)
    }

    @Test func `collapsed selected groups and expanded children do not become actionable roots`() throws {
        let parent = try self.row(0, fields: ["category": "Research", "childSessions": ["agent:bulk:thread-1"]])
        let child = try self.row(1, fields: ["category": "Research"])
        let ops = try self.row(2, fields: ["category": "Ops"])
        let sections = ChatSessionSidebarModel.sections(
            sessions: [parent, child, ops],
            currentSessionKey: parent.key,
            groups: [
                .init(name: "Research", position: 0),
                .init(name: "Ops", position: 1),
            ],
            query: "")
        #expect(ChatSidebarSelection
            .visibleRoots(in: sections, searching: false, isCollapsed: { $0 == "Research" }) == [ops])
        #expect(ChatSidebarSelection.visibleRoots(in: sections, searching: true, isCollapsed: { $0 == "Research" }) == [
            parent,
            ops,
        ])
    }

    @Test func `new group precedes guarded moves and survives partial assignment failure`() async throws {
        let rows = try (0..<205).map { try self.row($0, fields: ["pinned": $0 == 0]) }
        var methods: [String] = []
        var groupNames = ["Research", "Ops"]
        var sizes: [Int] = []
        let connection = try self.connection { request in
            methods.append(request.method)
            let params = try self.params(request)
            if request.method == "sessions.groups.put" {
                groupNames = try #require(params["names"] as? [String])
                #expect(groupNames == ["Research", "Ops", "Launch"])
                #expect(params["sectionOrder"] == nil)
            }
            if request.method.hasPrefix("sessions.groups.") {
                return try JSONSerialization.data(withJSONObject: [
                    "ok": true,
                    "groups": groupNames.enumerated().map { ["name": $0.element, "position": $0.offset] },
                    "sectionOrder": ["category:Research", "catalog:external", "category:Ops"],
                ])
            }
            let targets = try #require(params["targets"] as? [[String: Any]])
            #expect(params["patch"] as? [String: String] == ["category": "Launch"])
            sizes.append(targets.count)
            for target in targets {
                let key = try #require(target["key"] as? String)
                #expect(target["agentId"] as? String == "bulk")
                #expect(target["expectedSessionId"] as? String == "id-" + key.components(separatedBy: "thread-").last!)
            }
            let outcomes = try targets.map { target -> [String: Any] in
                let key = try #require(target["key"] as? String)
                return key == rows[101].key ?
                    ["key": key, "ok": false, "error": ["code": "CONFLICT", "message": "Thread replaced"]] :
                    ["key": key, "ok": true]
            }
            return try JSONSerialization.data(withJSONObject: ["outcomes": outcomes])
        }
        let batch = ChatSessionSidebarBatch()
        let success = await batch.run(.newGroup("Launch"), rows: rows, mainKey: "main", connection: connection)
        #expect(methods == ["sessions.groups.list", "sessions.groups.put"] + Array(
            repeating: "sessions.patchMany",
            count: 3))
        #expect(sizes == [100, 100, 5])
        #expect(success == rows.filter { $0.key != rows[101].key })
        #expect(batch.errors == [OpenClawChatSessionSidebarData.identity(rows[101]): "Thread replaced"])
        #expect(groupNames.contains("Launch"))
    }

    @Test func `new group requires every captured incarnation before writing the catalog`() async throws {
        var calls = 0
        let connection = try self.connection { _ in
            calls += 1
            return Data()
        }
        let rows = try [self.row(0), self.row(1, fields: ["sessionId": NSNull()])]
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.newGroup("Launch"), rows: rows, mainKey: "main", connection: connection).isEmpty)
        #expect(calls == 0)
        #expect(Set(batch.errors.keys) == Set(rows.map(OpenClawChatSessionSidebarData.identity)))
    }

    @Test func `failed new group catalog write reports every captured row without assigning any`() async throws {
        let rows = try [self.row(0), self.row(1)]
        var methods: [String] = []
        let connection = try self.connection { request in
            methods.append(request.method)
            if request.method == "sessions.groups.put" { throw URLError(.networkConnectionLost) }
            return Data(#"{"ok":true,"groups":[{"name":"Research","position":0}]}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.newGroup("Launch"), rows: rows, mainKey: "main", connection: connection).isEmpty)
        #expect(methods == ["sessions.groups.list", "sessions.groups.put"])
        #expect(Set(batch.errors.keys) == Set(rows.map(OpenClawChatSessionSidebarData.identity)))
    }

    @Test func `existing group names skip writes and ordinary moves skip catalog requests`() async throws {
        let rows = try [self.row(0), self.row(1)]
        var methods: [String] = []
        let connection = try self.connection { request in
            methods.append(request.method)
            if request.method == "sessions.groups.list" {
                return Data(#"{"ok":true,"groups":[{"name":"Research","position":0}]}"#.utf8)
            }
            let targets = try #require(self.params(request)["targets"] as? [[String: Any]])
            return try JSONSerialization.data(withJSONObject: [
                "outcomes": targets.map { ["key": $0["key"]!, "ok": true] },
            ])
        }
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.newGroup("Research"), rows: rows, mainKey: "main", connection: connection) == rows)
        #expect(methods == ["sessions.groups.list", "sessions.patchMany"])
        methods = []
        #expect(await batch.run(.category("Ops"), rows: rows, mainKey: "main", connection: connection) == rows)
        #expect(methods == ["sessions.patchMany"])
    }

    @Test func `205 roots use guarded sequential chunks and retain per-row partial failures`() async throws {
        let rows = try (0..<205).map { try self.row($0) }
        var sizes: [Int] = []
        let connection = try self.connection { request in
            #expect(request.method == "sessions.patchMany")
            let params = try self.params(request)
            let targets = try #require(params["targets"] as? [[String: Any]])
            #expect((params["patch"] as? [String: Bool]) == ["unread": true])
            for target in targets {
                #expect(target["agentId"] as? String == "bulk")
                let key = try #require(target["key"] as? String)
                #expect(target["expectedSessionId"] as? String == "id-" + key.components(separatedBy: "thread-").last!)
            }
            sizes.append(targets.count)
            let outcomes = try targets.map { target -> [String: Any] in
                let key = try #require(target["key"] as? String)
                return key == rows[101].key ? [
                    "key": key,
                    "ok": false,
                    "error": ["code": "CONFLICT", "message": "Thread replaced"],
                ] :
                    ["key": key, "ok": true]
            }
            return try JSONSerialization.data(withJSONObject: ["outcomes": outcomes])
        }
        let batch = ChatSessionSidebarBatch()
        let success = await batch.run(.unread(true), rows: rows, mainKey: "agent:bulk:main", connection: connection)
        #expect(sizes == [100, 100, 5])
        #expect(success.count == 204)
        #expect(success.first?.key == rows.first?.key)
        #expect(success.last?.key == rows.last?.key)
        #expect(batch.errors == [OpenClawChatSessionSidebarData.identity(rows[101]): "Thread replaced"])
    }

    @Test func `later chunk failure keeps completed rows and identifies every undispatched row`() async throws {
        let rows = try (0..<205).map { try self.row($0) }
        var calls = 0
        let connection = try self.connection { request in
            calls += 1
            if calls == 2 { throw URLError(.networkConnectionLost) }
            let targets = try #require(self.params(request)["targets"] as? [[String: Any]])
            return try JSONSerialization
                .data(withJSONObject: ["outcomes": targets.map { ["key": $0["key"]!, "ok": true] }])
        }
        let batch = ChatSessionSidebarBatch()
        let success = await batch.run(.category("Research"), rows: rows, mainKey: "main", connection: connection)
        #expect(calls == 2)
        #expect(success.map(\.key) == Array(rows.prefix(100)).map(\.key))
        #expect(Set(batch.errors.keys) == Set(rows.dropFirst(100).map(OpenClawChatSessionSidebarData.identity)))
    }

    @Test func `lifecycle preflight rejects incomplete selection and allows running or archived roots`() async throws {
        let running = try self.row(0, fields: ["hasActiveRun": true])
        let missing = try self.row(1, fields: ["sessionId": NSNull()])
        let archived = try self.row(2, fields: ["archived": true])
        var requests: [OpenClawChatGatewayRequest] = []
        let connection = try self.connection { request in
            requests.append(request)
            let targets = try #require(self.params(request)["targets"] as? [[String: Any]])
            return try JSONSerialization
                .data(withJSONObject: ["outcomes": targets.map { ["key": $0["key"]!, "ok": true] }])
        }
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.archived(true), rows: [running, missing], mainKey: "main", connection: connection)
            .isEmpty)
        #expect(requests.isEmpty)
        #expect(batch.errors.count == 2)
        #expect(await batch
            .run(.archived(true), rows: [running, archived], mainKey: "main", connection: connection) == [running])
        #expect(requests[0].timeoutMs == 600_000)
        #expect(await batch
            .run(.archived(false), rows: [archived], mainKey: "main", connection: connection) == [archived])
        #expect(try (self.params(requests[1])["patch"] as? [String: Bool]) == ["archived": false])
        #expect(!ChatSessionSidebarEligibility.canDelete([running, archived], mainSessionKey: "main"))
    }

    @Test func `query changes retain the busy owner and complete captured batch chunks`() async throws {
        let batch = ChatSessionSidebarBatch()
        batch.running = true
        let rows = try (0..<101).map { try self.row($0) }
        var calls = 0
        let connection = try self.connection { request in
            calls += 1
            batch.reset(clearConnection: false)
            #expect(batch.busy)
            let targets = try #require(self.params(request)["targets"] as? [[String: Any]])
            return try JSONSerialization
                .data(withJSONObject: ["outcomes": targets.map { ["key": $0["key"]!, "ok": true] }])
        }
        #expect(await batch.run(.unread(false), rows: rows, mainKey: "main", connection: connection) == rows)
        #expect(calls == 2)
        #expect(batch.errors.isEmpty)
    }

    @Test func `delete guards incarnation and reports preserved working copies`() async throws {
        let rows = try [self.row(0, fields: ["archived": true]), self.row(1, fields: ["archived": true])]
        let connection = try self.connection { request in
            let params = try self.params(request)
            #expect(request.method == "sessions.delete")
            #expect(request.timeoutMs == 600_000)
            #expect(params["archivedOnly"] as? Bool == true)
            #expect(params["deleteTranscript"] as? Bool == true)
            #expect(params["agentId"] as? String == "bulk")
            if params["key"] as? String == rows[1].key { throw URLError(.cannotConnectToHost) }
            #expect(params["expectedSessionId"] as? String == "id-0")
            return Data(
                #"""
                {"ok":true,"key":"agent:bulk:thread-0","deleted":true,"archived":[],
                 "worktreePreserved":{"id":"work-0","branch":"release","path":"/fixture/release","reason":"busy"}}
                """#
                    .utf8)
        }
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.delete, rows: rows, mainKey: "main", connection: connection) == [rows[0]])
        #expect(Set(batch.errors.keys) == [OpenClawChatSessionSidebarData.identity(rows[1])])
        #expect(batch.notices.count == 1)
        #expect(batch.notices[0].contains("/fixture/release"))
    }

    @Test func `section moves persist canonical tokens and preserve unrendered catalog positions`() async throws {
        let wire = Data(
            #"""
            {"groups":[{"name":"Research","position":0},{"name":"Ops","position":1}],
             "sectionOrder":["category:Research","catalog:external","category:Ops","ungrouped","groups","work"]}
            """#
                .utf8)
        var writes = 0
        let connection = try self.connection { request in
            if request.method == "sessions.groups.put" {
                writes += 1
                let params = try self.params(request)
                #expect(params["names"] as? [String] == ["Ops", "Research"])
                #expect(params["sectionOrder"] as? [String] == [
                    "category:Ops",
                    "category:Research",
                    "catalog:external",
                    "ungrouped",
                    "groups",
                    "work",
                ])
            } else { #expect(request.method == "sessions.groups.list") }
            return wire
        }
        let batch = ChatSessionSidebarBatch()
        _ = try await batch.moveSection("group:Ops", to: "group:Research", after: false, connection: connection)
        #expect(writes == 1)
    }

    @Test func `scoped archive rejects mixed ownership and false deletion fails`() async throws {
        var calls = 0
        let scoped = try self.connection(scopes: ["operator.sessions.write"]) { _ in
            calls += 1
            return Data()
        }
        let rows = try [self.row(0, fields: ["sharingRole": "owner"]), self.row(1, fields: ["sharingRole": "member"])]
        let batch = ChatSessionSidebarBatch()
        #expect(await batch.run(.archived(true), rows: rows, mainKey: "main", connection: scoped).isEmpty)
        #expect(calls == 0)
        #expect(batch.errors.count == 2)
        let connection = try self.connection { _ in
            Data(#"{"ok":true,"key":"agent:bulk:thread-0","deleted":false,"archived":[]}"#.utf8)
        }
        #expect(await batch.run(.delete, rows: [rows[0]], mainKey: "main", connection: connection).isEmpty)
        #expect(Set(batch.errors.keys) == [OpenClawChatSessionSidebarData.identity(rows[0])])
    }

    @Test(arguments: ["group:Ops", "recent"])
    func `a shared pin can change category on an old Gateway without changing its pin`(section: String) async throws {
        let pinned = try self.row(0, fields: ["pinned": true, "category": "Research"])
        let suite = "LegacyCategoryDrop.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let model = OpenClawChatViewModel(
            sessionKey: pinned.key,
            transport: TestChatTransport(historyResponses: []),
            activeAgentId: "bulk",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        model.sessions = [pinned]
        let batch = ChatSessionSidebarBatch()
        var requests: [OpenClawChatGatewayRequest] = []
        func sidebar(methods: Set<String>, scopes: Set<String>) -> ChatSessionSidebar {
            let connection = OpenClawSessionMenuConnection(
                methods: methods,
                scopes: scopes,
                isCurrent: { true },
                request: {
                    requests.append($0)
                    return Data(#"{"key":"agent:bulk:thread-0","entry":{"sessionId":"id-0","pinnedAt":10}}"#.utf8)
                })
            return ChatSessionSidebar(
                viewModel: model,
                query: .constant(""),
                groups: .constant([]),
                previews: .init(),
                menuActions: .init(connection: connection),
                batch: batch)
        }
        let methods: Set = ["sessions.groups.put", "sessions.patch"]
        let writer = sidebar(methods: methods, scopes: ["operator.write"])
        var drag = ChatSidebarDrag(scope: batch.scope, key: writer.interactionIdentity(pinned), sessionID: "stale")
        #expect(!writer.dropInteraction(drag, section: section, after: false))
        drag.sessionID = pinned.sessionId
        for target in ["group:Research", "list", "pinned"] {
            #expect(!writer.dropInteraction(drag, section: target, after: false))
        }
        let reader = sidebar(methods: methods, scopes: ["operator.read"])
        let noPatch = sidebar(methods: ["sessions.groups.put"], scopes: ["operator.write"])
        #expect(!reader.dropInteraction(drag, section: section, after: false))
        #expect(!noPatch.dropInteraction(drag, section: section, after: false))
        try #require(writer.dropInteraction(drag, section: section, after: false))
        await waitForObservedState { !batch.running }
        #expect(batch.notices.isEmpty)
        #expect(requests.map(\.method) == ["sessions.patch"])
        let params = try self.params(#require(requests.first))
        #expect(params as NSDictionary == [
            "key": pinned.key, "agentId": "bulk", "expectedSessionId": "id-0",
            "category": section == "recent" ? NSNull() as Any : "Ops",
        ] as NSDictionary)
    }

    @Test func `drop destinations distinguish unpin from category removal and reject nonpinnable roots`() throws {
        let pinned = try self.row(0, fields: ["pinned": true, "category": "Research"])
        func patch(_ row: OpenClawChatSessionEntry, _ section: String) throws -> NSDictionary? {
            guard case let .mutation(value)? = ChatSessionSidebarBatch.drop(row, section: section),
                  let value else { return nil }
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary
        }
        #expect(try patch(pinned, "group:Research") == ["pinned": false] as NSDictionary)
        #expect(try patch(pinned, "group:Ops") == ["category": "Ops", "pinned": false] as NSDictionary)
        #expect(try patch(pinned, "recent") == ["category": NSNull(), "pinned": false] as NSDictionary)
        #expect(try patch(pinned, "list") == ["pinned": false] as NSDictionary)
        guard case .mutation(nil)? = ChatSessionSidebarBatch.drop(pinned, section: "pinned") else {
            Issue.record("An existing pin must be reordered, not pinned again or rejected.")
            return
        }
        #expect(try patch(self.row(1), "pinned") == ["pinned": true] as NSDictionary)
        #expect(try patch(self.row(2, fields: ["archived": true]), "pinned") == nil)
        #expect(try patch(self.row(3, fields: ["spawnedBy": pinned.key]), "pinned") == nil)
        #expect(try patch(pinned, "person:someone") == nil)
    }

    @Test func `named insert binds both agents while self-drops are consumed`() throws {
        let source = try self.row(0, fields: ["key": "shared", "agentId": "research"])
        let target = try self.row(1, fields: ["key": "shared", "agentId": "ops", "pinned": true])
        guard case let .insert(key, anchor)? = ChatSessionSidebarBatch.drop(source, section: "pinned", target: target)
        else {
            Issue.record("Dropping onto another agent's row must insert the source beside it.")
            return
        }
        #expect(key == "agent:research:shared")
        #expect(anchor == "agent:ops:shared")
        guard case .selfDrop? = ChatSessionSidebarBatch.drop(target, section: "pinned", target: target) else {
            Issue.record("A self-drop must be consumed before the broad list can unpin it.")
            return
        }
    }

    @Test(arguments: [false, true])
    func `a named drop pins through the Gateway before placing the new pin`(snoozedElsewhere: Bool) async throws {
        let target = try self.row(0, fields: ["pinned": true, "agentId": "bulk"])
        let source = try self.row(1, fields: ["agentId": "bulk"])
        let suite = "NamedPinDrop.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let model = OpenClawChatViewModel(
            sessionKey: target.key,
            transport: TestChatTransport(historyResponses: []),
            activeAgentId: "bulk",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        model.sessions = [target, source]
        var layout = ["route:usage", "session:\(target.key)"]
        var methods: [String] = []
        let connection = try self.connection(scopes: ["operator.write"]) { request in
            methods.append(request.method)
            switch request.method {
            case "users.prefs.get":
                return try self.pinSnapshot(layout)
            case "users.prefs.set":
                layout = try self.pinPatch(request)
                return Data(#"{"status":"ok"}"#.utf8)
            default:
                #expect(try self.params(request)["expectedSessionId"] as? String == "id-1")
                // The Gateway owns snooze, archive and incarnation checks for a new pin.
                if snoozedElsewhere {
                    throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Snoozed"])
                }
                layout.append("session:\(source.key)")
                return Data(
                    #"{"ok":true,"key":"agent:bulk:thread-1","entry":{"sessionId":"id-1","updatedAt":2,"pinned":true}}"#
                        .utf8)
            }
        }
        _ = try await connection.pinProfile.read(connection)
        methods = []
        let batch = ChatSessionSidebarBatch()
        let sidebar = ChatSessionSidebar(
            viewModel: model,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
        let drag = ChatSidebarDrag(scope: batch.scope, key: sidebar.interactionIdentity(source), sessionID: "id-1")
        try #require(sidebar.dropInteraction(drag, section: "pinned", after: false, pinTarget: target))
        await waitForObservedState { !batch.running && !batch.busy }
        #expect(methods.first == "sessions.patch")
        if snoozedElsewhere {
            #expect(methods == ["sessions.patch"])
            #expect(layout == ["route:usage", "session:\(target.key)"])
        } else {
            #expect(methods.contains("users.prefs.set"))
            #expect(layout == ["route:usage", "session:\(source.key)", "session:\(target.key)"])
        }
    }
}
#endif
