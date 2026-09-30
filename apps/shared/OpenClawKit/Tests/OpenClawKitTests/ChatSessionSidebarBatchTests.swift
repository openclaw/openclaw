#if os(macOS)
import Foundation
import struct OpenClawKit.GatewayResponseError
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarBatchTests {
    private func connection(
        scopes: [String] = ["operator.admin"],
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data) throws -> OpenClawSessionMenuConnection
    {
        let hello = try JSONDecoder().decode(HelloOk.self, from: JSONSerialization.data(withJSONObject: [
            "type": "hello-ok", "protocol": 3, "server": [:],
            "features": ["methods": [
                "sessions.patchMany",
                "sessions.delete",
                "sessions.groups.list",
                "sessions.groups.put",
                "config.get",
                "config.patch",
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

    private func pinSnapshot(_ entries: [String], hash: String = "revision-1", valid: Bool = true) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "valid": valid, "hash": hash, "config": ["ui": ["prefs": ["sidebarEntries": entries]]],
        ])
    }

    private func pinPatch(_ request: OpenClawChatGatewayRequest) throws -> [String] {
        let params = try self.params(request)
        #expect(request.method == "config.patch")
        #expect(params["replacePaths"] as? [String] == ["ui.prefs.sidebarEntries"])
        let raw = try #require(params["raw"] as? String)
        let patch = try #require(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        #expect(Set(patch.keys) == ["ui"])
        let ui = try #require(patch["ui"] as? [String: Any])
        #expect(Set(ui.keys) == ["prefs"])
        let prefs = try #require(ui["prefs"] as? [String: Any])
        #expect(Set(prefs.keys) == ["sidebarEntries"])
        return try #require(prefs["sidebarEntries"] as? [String])
    }

    @Test func `pin reordering permutes session slots without changing foreign bytes or positions`() {
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
        let moved = ChatSessionSidebarBatch.movingPin(
            entries,
            keys: ["a", "b", "c"],
            key: "c",
            target: "a",
            after: false)
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
        #expect(ChatSessionSidebarBatch.movingPin(entries, keys: ["a"], key: "a", target: "a", after: true) == entries)
    }

    @Test func `missing pin slots append without moving non-session entries`() {
        let entries = ["session:a", "route:usage", "future:reserved"]
        #expect(ChatSessionSidebarBatch.movingPin(entries, keys: ["a", "b"], key: "b", target: "a", after: false) == [
            "session:b", "route:usage", "future:reserved", "session:a",
        ])
    }

    @Test func `failed preference write rolls optimistic pin ordering back to the server snapshot`() async throws {
        let entries = ["session:a", "future:reserved", "session:b"]
        let batch = ChatSessionSidebarBatch()
        var writes = 0
        let connection = try self.connection { request in
            if request.method == "config.get" { return try self.pinSnapshot(entries) }
            writes += 1
            #expect(batch.sidebarEntries == ["session:b", "future:reserved", "session:a"])
            #expect(try self.pinPatch(request) == batch.sidebarEntries)
            #expect(try self.params(request)["baseHash"] as? String == "revision-1")
            throw URLError(.cannotConnectToHost)
        }
        await #expect(throws: URLError.self) {
            try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        }
        #expect(writes == 1)
        #expect(batch.sidebarEntries == entries)
    }

    @Test func `changing a roster filter cannot strand a failed optimistic preference write`() async throws {
        let entries = ["session:a", "route:home", "session:b"]
        let batch = ChatSessionSidebarBatch()
        let connection = try self.connection { request in
            if request.method == "config.get" { return try self.pinSnapshot(entries) }
            batch.reset(clearConnection: false)
            throw URLError(.cannotConnectToHost)
        }
        await #expect(throws: URLError.self) {
            try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        }
        #expect(batch.sidebarEntries == entries)
    }

    @Test func `concurrent preference writers trigger a fresh guarded move preserving their entries`() async throws {
        var server = ["route:home", "session:a", "plugin:old", "session:b"]
        let remote = ["route:home", "session:a", "future:new", "session:b", "plugin:new", "route:tail"]
        var revision = 1
        var hashes: [String] = []
        let connection = try self.connection { request in
            if request.method == "config.get" { return try self.pinSnapshot(server, hash: "revision-\(revision)") }
            let hash = try #require(self.params(request)["baseHash"] as? String)
            hashes.append(hash)
            if hashes.count == 1 { server = remote
                revision = 2
            }
            guard hash == "revision-\(revision)" else {
                throw GatewayResponseError(
                    method: "config.patch",
                    code: "INVALID_REQUEST",
                    message: "config changed since last load; re-run config.get and retry",
                    details: nil)
            }
            server = try self.pinPatch(request)
            revision += 1
            return Data(#"{"ok":true}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        #expect(hashes == ["revision-1", "revision-2"])
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

    @Test func `post-commit reconciliation accepts another client's newer pin order`() async throws {
        let before = ["session:a", "route:home", "session:b"]
        let external = ["session:a", "route:home", "session:b", "future:added"]
        var committed = false
        let connection = try self.connection { request in
            if request.method == "config.patch" { committed = true
                return Data(#"{"ok":true}"#.utf8)
            }
            return try self.pinSnapshot(committed ? external : before)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        #expect(batch.sidebarEntries == external)
    }

    @Test func `first pin persistence retains default web links while explicit empty preferences stay empty`() async throws {
        var written: [String]?
        let connection = try self.connection { request in
            if request.method == "config.patch" {
                written = try self.pinPatch(request)
                return Data(#"{"ok":true}"#.utf8)
            }
            if let written { return try self.pinSnapshot(written) }
            return Data(#"{"valid":true,"hash":"revision-1","config":{}}"#.utf8)
        }
        let batch = ChatSessionSidebarBatch()
        try await batch.movePin(keys: ["a"], key: "a", target: nil, after: false, connection: connection)
        #expect(written == [
            "route:agents-home",
            "route:dashboards",
            "route:systems",
            "route:cron",
            "route:plugins",
            "session:a",
        ])
        let empty = try self.connection { _ in try self.pinSnapshot([]) }
        try await batch.refreshPins(empty)
        #expect(batch.sidebarEntries.isEmpty)
    }

    @Test func `external invalidation during post-commit read is reconciled before settlement`() async throws {
        let batch = ChatSessionSidebarBatch()
        let newer = ["session:a", "future:remote", "session:b"]
        let observer = try self.connection { _ in try self.pinSnapshot(newer) }
        var reads = 0
        var writes = 0
        let connection = try self.connection { request in
            if request.method == "config.patch" { writes += 1
                return Data(#"{"ok":true}"#.utf8)
            }
            reads += 1
            if reads == 2 {
                try await batch.refreshPins(observer)
                return try self.pinSnapshot(["session:b", "route:old", "session:a"])
            }
            return try self.pinSnapshot(reads == 1 ? ["session:a", "route:old", "session:b"] : newer)
        }
        try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        #expect(writes == 1)
        #expect(batch.sidebarEntries == newer)
    }

    @Test(arguments: [1, 2])
    func `pending external invalidation survives a failed preference read`(failedRead: Int) async throws {
        let batch = ChatSessionSidebarBatch()
        let newer = ["session:a", "future:remote", "session:b"]
        let observer = try self.connection { _ in try self.pinSnapshot(newer) }
        var reads = 0
        var writes = 0
        let connection = try self.connection { request in
            if request.method == "config.patch" { writes += 1
                return Data(#"{"ok":true}"#.utf8)
            }
            reads += 1
            if reads == failedRead {
                try await batch.refreshPins(observer)
                throw URLError(.cannotConnectToHost)
            }
            return try self.pinSnapshot(reads == 1 ? ["session:a", "route:old", "session:b"] : newer)
        }
        if failedRead == 1 {
            await #expect(throws: URLError.self) {
                try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
            }
        } else {
            try await batch.movePin(keys: ["a", "b"], key: "b", target: "a", after: false, connection: connection)
        }
        #expect(writes == failedRead - 1)
        #expect(batch.sidebarEntries == newer)
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
        let nodes = ChatSessionSidebarModel.tree(from: [research, ops]).map {
            ChatSidebarSelection.Node($0, identity: OpenClawChatSessionSidebarData.identity)
        }
        #expect(Set(nodes.map(\.id)).count == 2)
        #expect(targets.sorted() == ["ops", "research"])
        #expect(deleted == [research])
        #expect(batch.errors.count == 1)
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(ops)] != nil)
    }

    @Test func `invalid configuration and retired reads cannot replace the preference mirror`() async throws {
        let batch = ChatSessionSidebarBatch()
        let initial = try self.connection { _ in try self.pinSnapshot(["session:a"]) }
        try await batch.refreshPins(initial)
        let invalid = try self.connection { _ in try self.pinSnapshot([], valid: false) }
        await #expect(throws: CocoaError.self) { try await batch.refreshPins(invalid) }
        #expect(batch.sidebarEntries == ["session:a"])
        let current = try self.connection { _ in try self.pinSnapshot(["session:new"]) }
        let replaced = try self.connection { _ in
            batch.reset()
            try await batch.refreshPins(current)
            return try self.pinSnapshot(["session:old"])
        }
        try await batch.refreshPins(replaced)
        #expect(batch.sidebarEntries == ["session:new"])
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
            let outcomes = targets.map { target -> [String: Any] in
                let key = target["key"] as! String
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

    @Test func `lifecycle preflight rejects incomplete selection but permits running roots and restores archived rows`() async throws {
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

    @Test func `reset during a response neither dispatches the next chunk nor publishes old errors`() async throws {
        let batch = ChatSessionSidebarBatch()
        let rows = try (0..<101).map { try self.row($0) }
        var calls = 0
        let connection = try self.connection { request in
            calls += 1
            batch.reset()
            let targets = try #require(self.params(request)["targets"] as? [[String: Any]])
            return try JSONSerialization
                .data(withJSONObject: ["outcomes": targets.map { ["key": $0["key"]!, "ok": true] }])
        }
        #expect(await batch.run(.unread(false), rows: rows, mainKey: "main", connection: connection).isEmpty)
        #expect(calls == 1)
        #expect(batch.errors.isEmpty)
    }

    @Test func `delete guards archived incarnation and exposes preserved working copies beside failures`() async throws {
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
                #"{"ok":true,"key":"agent:bulk:thread-0","deleted":true,"archived":[],"worktreePreserved":{"id":"work-0","branch":"release","path":"/fixture/release","reason":"busy"}}"#
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
            #"{"groups":[{"name":"Research","position":0},{"name":"Ops","position":1}],"sectionOrder":["category:Research","catalog:external","category:Ops","ungrouped","groups","work"]}"#
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
        batch.connection = connection
        _ = try await batch.moveSection("group:Ops", to: "group:Research", after: false)
        #expect(writes == 1)
    }

    @Test func `scoped archive rejects mixed ownership before dispatch and false deletion remains a failure`() async throws {
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

    @Test func `drop destinations distinguish unpin from category removal and reject nonpinnable roots`() throws {
        let pinned = try self.row(0, fields: ["pinned": true, "category": "Research"])
        func patch(_ row: OpenClawChatSessionEntry, _ section: String) throws -> NSDictionary? {
            guard case let .mutation(value)? = ChatSessionSidebarBatch.drop(row, section: section),
                  let value else { return nil }
            return try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary
        }
        #expect(try patch(pinned, "group:Ops") == ["category": "Ops", "pinned": false] as NSDictionary)
        #expect(try patch(pinned, "recent") == ["category": NSNull(), "pinned": false] as NSDictionary)
        #expect(try patch(pinned, "list") == ["pinned": false] as NSDictionary)
        #expect(try patch(pinned, "pinned") == nil)
        #expect(try patch(self.row(1), "pinned") == ["pinned": true] as NSDictionary)
        #expect(try patch(self.row(2, fields: ["archived": true]), "pinned") == nil)
        #expect(try patch(self.row(3, fields: ["spawnedBy": pinned.key]), "pinned") == nil)
        #expect(try patch(pinned, "person:someone") == nil)
    }

    @Test func `pin drops distinguish same-key roots from different agents and consume actual self-drops`() throws {
        let source = try self.row(0, fields: ["key": "shared", "agentId": "research"])
        let target = try self.row(1, fields: ["key": "shared", "agentId": "ops", "pinned": true])
        let drop = ChatSessionSidebarBatch.drop(source, section: "pinned", target: target)
        guard case let .mutation(fields)? = drop else {
            Issue.record("Dropping onto another agent's row must pin the source.")
            return
        }
        #expect(fields?["pinned"]?.value as? Bool == true)
        guard case .selfDrop? = ChatSessionSidebarBatch.drop(target, section: "pinned", target: target) else {
            Issue.record("A self-drop must be consumed before the broad list can unpin it.")
            return
        }
    }
}
#endif
