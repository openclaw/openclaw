#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

private actor ArchiveUndoQueryTransport: OpenClawChatSidebarTransport {
    struct Pending: Sendable {
        let request: OpenClawChatGatewayRequest
        let reply: CheckedContinuation<Data, any Error>
    }

    private var pending: Pending?
    private var waiting: CheckedContinuation<Pending, Never>?
    private(set) var requestCount = 0

    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data {
        { try await self.send($0) }
    }

    private func send(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        self.requestCount += 1
        return try await withCheckedThrowingContinuation { reply in
            let call = Pending(request: request, reply: reply)
            if let waiting = self.waiting {
                self.waiting = nil
                waiting.resume(returning: call)
            } else { self.pending = call }
        }
    }

    func next() async -> Pending {
        if let pending = self.pending {
            self.pending = nil
            return pending
        }
        return await withCheckedContinuation { self.waiting = $0 }
    }

    func loadSidebarAgentAvatar(_: String) async -> Data? {
        nil
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }
}

@MainActor
struct ChatSessionSidebarArchiveUndoTests {
    private func row(_ key: String = "thread", pinned: Bool = true) throws -> OpenClawChatSessionEntry {
        try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: JSONSerialization.data(withJSONObject: [
            "key": "agent:research:\(key)", "agentId": "research", "sessionId": "original-\(key)", "pinned": pinned,
            "updatedAt": 10,
        ]))
    }

    func connection(
        current: @escaping () -> Bool = { true },
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data) throws -> OpenClawSessionMenuConnection
    {
        let hello = try JSONDecoder().decode(HelloOk.self, from: JSONSerialization.data(withJSONObject: [
            "type": "hello-ok", "protocol": 3, "server": [:],
            "features": ["methods": ["sessions.patch", "sessions.patchMany", "sessions.delete"]],
            "snapshot": ["presence": [], "health": [:], "stateVersion": ["presence": 0, "health": 0], "uptimeMs": 0],
            "auth": ["scopes": ["operator.admin"]], "policy": [:],
        ]))
        return .init(
            hello: hello,
            local: false,
            isCurrent: current,
            request: request,
            link: { _, _ in nil },
            openWindow: { _ in })
    }

    private func acknowledgement(_ row: OpenClawChatSessionEntry, archived: Bool) throws -> Data {
        var entry: [String: Any] = ["sessionId": row.sessionId!, "updatedAt": archived ? 20 : 30]
        if archived {
            entry["archivedAt"] = 20
        } else if row.pinned == true {
            entry["pinnedAt"] = 30
        }
        return try JSONSerialization.data(withJSONObject: ["ok": true, "key": row.key, "entry": entry])
    }

    private func undo(_ batch: ChatSessionSidebarBatch, owner: OpenClawChatSessionSidebarData?) async {
        guard let displayed = batch.archiveUndo, let receipt = batch.takeArchiveUndo(id: displayed.id) else {
            Issue.record("Missing Archive Undo receipt")
            return
        }
        await batch.undoArchive(receipt, owner: owner)
    }

    private func page(_ rows: [OpenClawChatSessionEntry]) throws -> Data {
        struct Page: Encodable {
            let sessions: [OpenClawChatSessionEntry]
            let hasMore = false
        }
        return try JSONEncoder().encode(Page(sessions: rows))
    }

    private func load(
        _ owner: OpenClawChatSessionSidebarData,
        transport: ArchiveUndoQueryTransport,
        rows: [OpenClawChatSessionEntry]) async throws
    {
        let response = try self.page(rows)
        let task = Task { await owner.load() }
        let call = await transport.next()
        #expect(call.request.method == "sessions.list")
        call.reply.resume(returning: response)
        await task.value
    }

    @Test(arguments: [false, true], [false, true])
    func `undo immediately restores active query membership after archive refresh`(
        multiple: Bool, delayedRefresh: Bool) async throws
    {
        let batch = ChatSessionSidebarBatch()
        let rows = try (0..<(multiple ? 3 : 1)).map { try self.row("thread-\($0)", pinned: false) }
        let owner = OpenClawChatSessionSidebarData()
        let transport = ArchiveUndoQueryTransport()
        owner.configureQueries(transport: transport, query: .init(agentID: "research"))
        try await self.load(owner, transport: transport, rows: rows)
        #expect(owner.rows.map(\.sessionId) == rows.map(\.sessionId))
        let failedKey = multiple ? rows.last?.key : nil
        let connection = try self.connection { request in
            if request.method == "sessions.patch" {
                let row = try #require(rows.first { $0.key == request.params["key"]?.value as? String })
                let archived = request.params["archived"]?.value as? Bool == true
                if !archived, row.key == failedKey {
                    throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Restore failed"])
                }
                return try self.acknowledgement(row, archived: archived)
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            let patch = try #require(params["patch"] as? [String: Bool])
            return try JSONSerialization.data(withJSONObject: ["outcomes": targets.map { target -> [String: Any] in
                let key = target["key"]!
                return patch["archived"] == false && key == failedKey ?
                    ["key": key, "ok": false, "error": ["message": "Restore failed"]] :
                    ["key": key, "ok": true]
            }])
        }
        if multiple {
            #expect(await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection) == rows)
        } else {
            #expect(await batch.archive(rows[0], mainKey: "main", connection: connection, owner: owner) != nil)
        }
        // The archive-triggered Active refresh evicts membership while the owner retains row facts.
        try await self.load(owner, transport: transport, rows: [])
        #expect(owner.rows.isEmpty)
        var staleTask: Task<Void, Never>?
        var stale: ArchiveUndoQueryTransport.Pending?
        if delayedRefresh {
            staleTask = Task { await owner.load() }
            stale = await transport.next()
        }
        let countBeforeUndo = await transport.requestCount
        await self.undo(batch, owner: owner)
        let expected = rows.filter { $0.key != failedKey }.map(\.sessionId)
        #expect(Set(owner.rows(at: Date(timeIntervalSince1970: 100)).map(\.sessionId)) == Set(expected))
        #expect(await transport.requestCount == countBeforeUndo)
        if let stale {
            try stale.reply.resume(returning: self.page([]))
            await staleTask?.value
            #expect(Set(owner.rows(at: Date(timeIntervalSince1970: 100)).map(\.sessionId)) == Set(expected))
        }
        // A read started after the restore receipt can authoritatively omit the row again.
        try await self.load(owner, transport: transport, rows: [])
        #expect(owner.rows(at: Date(timeIntervalSince1970: 100)).isEmpty)
        for row in rows where row.key != failedKey {
            #expect(owner.row(key: row.key, agentID: row.agentId)?.isArchived == false)
        }
        if let failedKey {
            let failed = try #require(rows.first { $0.key == failedKey })
            #expect(batch.errors[OpenClawChatSessionSidebarData.identity(failed)] == "Restore failed")
        }
    }

    @Test func `undo after agent navigation restores facts without admitting a foreign row`() async throws {
        let batch = ChatSessionSidebarBatch()
        let row = try self.row(pinned: false)
        var other = try self.row("other", pinned: false)
        other.key = "agent:other:thread"
        other.agentId = "other"
        let owner = OpenClawChatSessionSidebarData()
        let transport = ArchiveUndoQueryTransport()
        owner.configureQueries(transport: transport, query: .init(agentID: "research"))
        try await self.load(owner, transport: transport, rows: [row])
        let connection = try self.connection { request in
            try self.acknowledgement(row, archived: request.params["archived"]?.value as? Bool == true)
        }
        #expect(await batch.archive(row, mainKey: "main", connection: connection, owner: owner) != nil)
        owner.setQuery(.init(agentID: "other"))
        try await self.load(owner, transport: transport, rows: [other])
        await self.undo(batch, owner: owner)
        #expect(owner.row(key: row.key, agentID: "research")?.isArchived == false)
        #expect(owner.rows(at: Date(timeIntervalSince1970: 100)) == [other])
    }

    @Test(arguments: [false, true], [false, true])
    func `undo survives navigation and restores the captured pin and incarnation`(
        pinned: Bool,
        navigateDuringArchive: Bool) async throws
    {
        let batch = ChatSessionSidebarBatch()
        let row = try self.row(pinned: pinned)
        let owner = OpenClawChatSessionSidebarData()
        owner.receive([row], read: owner.beginRead())
        var requests: [OpenClawChatGatewayRequest] = []
        let connection = try self.connection { request in
            #expect(batch.archiveUndo == nil)
            requests.append(request)
            #expect(request.params["key"]?.value as? String == row.key)
            #expect(request.params["agentId"]?.value as? String == "research")
            #expect(request.params["expectedSessionId"]?.value as? String == "original-thread")
            let archived = request.params["archived"]?.value as? Bool == true
            if archived, navigateDuringArchive { batch.reset(clearConnection: false) }
            #expect(request.timeoutMs == (archived ? 600_000 : 15000))
            return try self.acknowledgement(row, archived: archived)
        }
        #expect(await batch.archive(row, mainKey: "main", connection: connection, owner: owner) != nil)
        #expect(owner.row(key: row.key, agentID: "research")?.isArchived == true)
        #expect(owner.row(key: row.key, agentID: "research")?.pinned == false)
        batch.reset(clearConnection: false)
        #expect(batch.archiveUndo?.rows == [row])
        await self.undo(batch, owner: owner)
        #expect(requests.count == 2)
        #expect(requests.last?.params["archived"]?.value as? Bool == false)
        #expect(requests.last?.params["pinned"]?.value as? Bool == (pinned ? true : nil))
        #expect(owner.row(key: row.key, agentID: "research")?.isArchived == false)
        #expect(owner.row(key: row.key, agentID: "research")?.pinned == pinned)
    }

    @Test func `replacement identity remains untouched and restore failure stays visible`() async throws {
        let batch = ChatSessionSidebarBatch()
        let row = try self.row()
        let owner = OpenClawChatSessionSidebarData()
        let transport = ArchiveUndoQueryTransport()
        owner.configureQueries(transport: transport, query: .init(agentID: "research"))
        try await self.load(owner, transport: transport, rows: [row])
        let connection = try self.connection { request in
            if request.params["archived"]?
                .value as? Bool == true { return try self.acknowledgement(row, archived: true) }
            #expect(request.params["expectedSessionId"]?.value as? String == "original-thread")
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Session changed before patch."])
        }
        #expect(await batch.archive(row, mainKey: "main", connection: connection, owner: owner) != nil)
        var replacement = row
        replacement.sessionId = "replacement"
        replacement.updatedAt = 40
        try await self.load(owner, transport: transport, rows: [replacement])
        await self.undo(batch, owner: owner)
        #expect(owner.row(key: row.key, agentID: "research") == replacement)
        #expect(owner.rows(at: Date(timeIntervalSince1970: 100)) == [replacement])
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(row)] == "Session changed before patch.")
        #expect(batch.archiveUndo == nil)
    }

    @Test func `failed archives offer no undo and reconnect fences captured receipts`() async throws {
        let batch = ChatSessionSidebarBatch()
        let row = try self.row()
        var current = true
        var fail = true
        var calls = 0
        let connection = try self.connection(current: { current }, request: { _ in
            calls += 1
            if fail { throw URLError(.cannotConnectToHost) }
            return try self.acknowledgement(row, archived: true)
        })
        #expect(await batch.archive(row, mainKey: "main", connection: connection, owner: nil) == nil)
        #expect(batch.archiveUndo == nil)
        fail = false
        #expect(await batch.archive(row, mainKey: "main", connection: connection, owner: nil) != nil)
        current = false
        await self.undo(batch, owner: nil)
        #expect(calls == 2)
        #expect(batch.notices == ["The Gateway changed. Archive Undo is no longer available."])
    }

    @Test func `batch undo restores successful captures with their pins atomically`() async throws {
        let batch = ChatSessionSidebarBatch()
        let rows = try [self.row("one"), self.row("two"), self.row("three", pinned: false)]
        var restoredKeys: Set<String> = []
        let connection = try self.connection { request in
            if request.method == "sessions.patch" {
                let row = try #require(rows.first { $0.key == request.params["key"]?.value as? String })
                restoredKeys.insert(row.key)
                #expect(request.params["agentId"]?.value as? String == "research")
                #expect(request.params["expectedSessionId"]?.value as? String == row.sessionId)
                #expect(request.params["archived"]?.value as? Bool == false)
                #expect(request.params["pinned"]?.value as? Bool == (row.pinned == true ? true : nil))
                if row.key == rows[2].key {
                    throw NSError(
                        domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Changed \(row.key)"])
                }
                return try self.acknowledgement(row, archived: false)
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let captured = try #require(params["targets"] as? [[String: String]])
            let keys = captured.compactMap { $0["key"] }
            #expect(keys == rows.map(\.key))
            batch.reset(clearConnection: false)
            for target in captured {
                #expect(target["agentId"] == "research")
                #expect(target["expectedSessionId"] == rows.first { $0.key == target["key"] }?.sessionId)
            }
            return try JSONSerialization.data(withJSONObject: ["outcomes": keys.map { key -> [String: Any] in
                key == rows[1].key ? ["key": key, "ok": false, "error": ["message": "Changed \(key)"]] : [
                    "key": key,
                    "ok": true,
                ]
            }])
        }
        #expect(await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection) == [
            rows[0],
            rows[2],
        ])
        #expect(batch.archiveUndo?.rows == [rows[0], rows[2]])
        batch.reset(clearConnection: false)
        await self.undo(batch, owner: nil)
        #expect(restoredKeys == Set([rows[0].key, rows[2].key]))
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(rows[2])] == "Changed \(rows[2].key)")
    }

    @Test func `undo lifetime pauses for interaction and a newer receipt replaces its deadline`() throws {
        let batch = ChatSessionSidebarBatch()
        let connection = try self.connection { _ in Data() }
        let first = try self.row()
        batch.offerArchiveUndo([first], connection: connection)
        let deadline = try #require(batch.archiveUndo?.deadline)
        batch.archiveUndo?.pause(true, now: deadline.advanced(by: .seconds(-4)))
        batch.expireArchiveUndo(now: deadline.advanced(by: .seconds(100)))
        #expect(batch.archiveUndo?.rows == [first])
        batch.archiveUndo?.pause(false, now: deadline.advanced(by: .seconds(100)))
        #expect(batch.archiveUndo?.deadline == deadline.advanced(by: .seconds(104)))
        batch.expireArchiveUndo(now: deadline.advanced(by: .seconds(103)))
        #expect(batch.archiveUndo != nil)
        batch.expireArchiveUndo(now: deadline.advanced(by: .seconds(104)))
        #expect(batch.archiveUndo == nil)
        #expect(batch.notices.isEmpty)
        batch.offerArchiveUndo([first], connection: connection)
        let oldID = try #require(batch.archiveUndo?.id)
        let second = try self.row("second")
        batch.offerArchiveUndo([second], connection: connection)
        #expect(batch.takeArchiveUndo(id: oldID) == nil)
        #expect(batch.archiveUndo?.id != oldID)
        #expect(batch.archiveUndo?.rows == [second])
        #expect(batch.archiveUndo?.remaining == .seconds(6))
        batch.reset()
        #expect(batch.archiveUndo == nil)
    }

    @Test(arguments: ["archive", "restore"])
    func `query navigation preserves earlier archive and restore failures`(failurePhase: String) async throws {
        let batch = ChatSessionSidebarBatch()
        let rows = try (0..<205).map { try self.row("thread-\($0)") }
        var calls: [String: Int] = [:]
        let connection = try self.connection { request in
            let phase = request.method == "sessions.patch" ? "restore" : "archive"
            calls[phase, default: 0] += 1
            if phase == "archive", failurePhase == "archive", calls[phase] == 2 {
                batch.reset(clearConnection: false)
            }
            if phase == "restore" {
                let row = try #require(rows.first { $0.key == request.params["key"]?.value as? String })
                if failurePhase == "restore", row.key == rows[0].key {
                    throw NSError(
                        domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Changed captured thread"])
                }
                if row.key == rows.last?.key {
                    #expect(batch.errors[OpenClawChatSessionSidebarData.identity(rows[0])] == "Changed captured thread")
                    batch.reset(clearConnection: false)
                }
                return try self.acknowledgement(row, archived: false)
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            return try JSONSerialization.data(withJSONObject: ["outcomes": targets.map { target -> [String: Any] in
                let key = target["key"]!
                return phase == failurePhase && key == rows[0].key ?
                    ["key": key, "ok": false, "error": ["message": "Changed captured thread"]] :
                    ["key": key, "ok": true]
            }])
        }
        _ = await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection)
        if failurePhase != "archive" { await self.undo(batch, owner: nil) }
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(rows[0])] == "Changed captured thread")
    }

    @Test func `pending archives survive query changes and only gate the same incarnation`() async throws {
        let batch = ChatSessionSidebarBatch()
        let first = try self.row(), second = try self.row("other")
        var reply: CheckedContinuation<Data, any Error>?
        var started: CheckedContinuation<Void, Never>?
        let connection = try self.connection { request in
            if request.method == "sessions.patch" {
                return try await withCheckedThrowingContinuation { reply = $0
                    started?.resume()
                }
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            #expect(targets.map { $0["key"] } == [second.key])
            #expect(batch.isArchiving(first) && batch.isArchiving(second))
            return Data(#"{"outcomes":[{"key":"agent:research:other","ok":true}]}"#.utf8)
        }
        var task: Task<ChatSidebarArchiveReceipt?, Never>?
        await withCheckedContinuation { started = $0
            task = Task { await batch.archive(first, mainKey: "main", connection: connection, owner: nil) }
        }
        batch.reset(clearConnection: false)
        #expect(batch.isArchiving(first))
        var replacement = first
        replacement.sessionId = "replacement"
        #expect(!batch.isArchiving(replacement))
        #expect(await batch.archive(first, mainKey: "main", connection: connection, owner: nil) == nil)
        #expect(await batch
            .run(.archived(true), rows: [first, second], mainKey: "main", connection: connection) == [second])
        #expect(batch.isArchiving(first) && !batch.isArchiving(second))
        try reply?.resume(returning: self.acknowledgement(first, archived: true))
        #expect(await task?.value?.rows == [first])
        #expect(!batch.isArchiving(first))
    }

    @Test func `retired completion cannot clear a newer same-target pending archive`() async throws {
        let batch = ChatSessionSidebarBatch()
        let row = try self.row()
        var generation = 0
        var oldReply: CheckedContinuation<Data, any Error>?
        var newReply: CheckedContinuation<Data, any Error>?
        var started: CheckedContinuation<Void, Never>?
        let old = try self.connection(current: { generation == 0 }, request: { _ in
            try await withCheckedThrowingContinuation { oldReply = $0
                started?.resume()
            }
        })
        let current = try self.connection(current: { generation == 1 }, request: { _ in
            try await withCheckedThrowingContinuation { newReply = $0
                started?.resume()
            }
        })
        var oldTask: Task<ChatSidebarArchiveReceipt?, Never>?
        await withCheckedContinuation { started = $0
            oldTask = Task { await batch.archive(row, mainKey: "main", connection: old, owner: nil) }
        }
        generation = 1
        batch.reset()
        var newTask: Task<ChatSidebarArchiveReceipt?, Never>?
        await withCheckedContinuation { started = $0
            newTask = Task { await batch.archive(row, mainKey: "main", connection: current, owner: nil) }
        }
        let acknowledged = try self.acknowledgement(row, archived: true)
        oldReply?.resume(returning: acknowledged)
        #expect(await oldTask?.value == nil)
        #expect(batch.isArchiving(row))
        newReply?.resume(returning: acknowledged)
        #expect(await newTask?.value?.rows == [row])
        #expect(!batch.isArchiving(row))
    }

    @Test(arguments: [false, true])
    func `overlapping completion preserves failures published after it began`(secondFails: Bool) async throws {
        let batch = ChatSessionSidebarBatch()
        let first = try self.row("first"), second = try self.row("second")
        var replies: [String: CheckedContinuation<Data, any Error>] = [:]
        var started: CheckedContinuation<Void, Never>?
        let connection = try self.connection { request in
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            let key = try #require(targets.first?["key"])
            return try await withCheckedThrowingContinuation { replies[key] = $0
                started?.resume()
            }
        }
        var firstTask: Task<[OpenClawChatSessionEntry], Never>?
        await withCheckedContinuation { started = $0
            firstTask = Task { await batch.run(.archived(true), rows: [first], mainKey: "main", connection: connection)
            }
        }
        batch.reset(clearConnection: false)
        var secondTask: Task<[OpenClawChatSessionEntry], Never>?
        await withCheckedContinuation { started = $0
            secondTask = Task { await batch.run(
                .category("Research"),
                rows: [second],
                mainKey: "main",
                connection: connection) }
        }
        try replies[first.key]?.resume(returning: JSONSerialization.data(withJSONObject: ["outcomes": [[
            "key": first.key, "ok": false, "error": ["code": "INVALID_REQUEST", "message": "First archive failed"],
        ]]]))
        _ = await firstTask?.value
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(first)] == "First archive failed")
        var outcome: [String: Any] = ["key": second.key, "ok": !secondFails]
        if secondFails { outcome["error"] = ["code": "INVALID_REQUEST", "message": "Second operation failed"] }
        try replies[second.key]?.resume(returning: JSONSerialization.data(withJSONObject: ["outcomes": [outcome]]))
        _ = await secondTask?.value
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(first)] == "First archive failed")
        #expect(batch
            .errors[OpenClawChatSessionSidebarData.identity(second)] == (secondFails ? "Second operation failed" : nil))
    }

    @Test func `successful undo preserves a concurrent single archive failure`() async throws {
        let batch = ChatSessionSidebarBatch()
        let single = try self.row("single"), rows = try [self.row("one"), self.row("two")]
        var singleReply: CheckedContinuation<Data, any Error>?
        var undoReply: CheckedContinuation<Data, any Error>?
        var started: CheckedContinuation<Void, Never>?
        let connection = try self.connection { request in
            if request.method == "sessions.patch" {
                let key = try #require(request.params["key"]?.value as? String)
                if key == single.key {
                    return try await withCheckedThrowingContinuation { singleReply = $0
                        started?.resume()
                    }
                }
                if key == rows[0].key {
                    return try await withCheckedThrowingContinuation { undoReply = $0
                        started?.resume()
                    }
                }
                let row = try #require(rows.first { $0.key == key })
                return try self.acknowledgement(row, archived: false)
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            return try JSONSerialization.data(withJSONObject: ["outcomes": targets.map {
                ["key": $0["key"]!, "ok": true] as [String: Any]
            }])
        }
        var singleTask: Task<ChatSidebarArchiveReceipt?, Never>?
        await withCheckedContinuation { started = $0
            singleTask = Task { await batch.archive(single, mainKey: "main", connection: connection, owner: nil) }
        }
        _ = await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection)
        var undoTask: Task<Void, Never>?
        await withCheckedContinuation { started = $0
            undoTask = Task { await self.undo(batch, owner: nil) }
        }
        singleReply?.resume(throwing: NSError(
            domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Single archive failed"]))
        _ = await singleTask?.value
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(single)] == "Single archive failed")
        try undoReply?.resume(returning: self.acknowledgement(rows[0], archived: false))
        await undoTask?.value
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(single)] == "Single archive failed")
    }

    @Test func `overlapping single archive failures both remain visible`() async throws {
        let batch = ChatSessionSidebarBatch()
        let rows = try [self.row("one"), self.row("two")]
        var replies: [String: CheckedContinuation<Data, any Error>] = [:]
        var started: CheckedContinuation<Void, Never>?
        let connection = try self.connection { request in
            let key = try #require(request.params["key"]?.value as? String)
            return try await withCheckedThrowingContinuation { replies[key] = $0
                started?.resume()
            }
        }
        var tasks: [Task<ChatSidebarArchiveReceipt?, Never>] = []
        for row in rows {
            await withCheckedContinuation { started = $0
                tasks.append(Task { await batch.archive(row, mainKey: "main", connection: connection, owner: nil) })
            }
        }
        for (index, row) in rows.enumerated() {
            replies[row.key]?.resume(throwing: NSError(
                domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed \(row.key)"]))
            _ = await tasks[index].value
        }
        #expect(Set(batch.notices + Array(batch.errors.values)) == Set(rows.map { "Failed \($0.key)" }))
    }

    @Test func `delete completion preserves concurrently published undo failures`() async throws {
        let batch = ChatSessionSidebarBatch()
        let rows = try [self.row("one", pinned: false), self.row("two", pinned: false)]
        let deleted = try self.row("delete", pinned: false)
        var deleteReply: CheckedContinuation<Data, any Error>?
        var started: CheckedContinuation<Void, Never>?
        let connection = try self.connection { request in
            if request.method == "sessions.delete" {
                return try await withCheckedThrowingContinuation { deleteReply = $0
                    started?.resume()
                }
            }
            if request.method == "sessions.patch" {
                let row = try #require(rows.first { $0.key == request.params["key"]?.value as? String })
                if row.key == rows[0].key {
                    throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "Restore failed"])
                }
                return try self.acknowledgement(row, archived: false)
            }
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            let targets = try #require(params["targets"] as? [[String: String]])
            return try JSONSerialization.data(withJSONObject: ["outcomes": targets.map {
                ["key": $0["key"]!, "ok": true] as [String: Any]
            }])
        }
        _ = await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection)
        var deleteTask: Task<[OpenClawChatSessionEntry], Never>?
        await withCheckedContinuation { started = $0
            deleteTask = Task { await batch.run(.delete, rows: [deleted], mainKey: "main", connection: connection) }
        }
        await self.undo(batch, owner: nil)
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(rows[0])] == "Restore failed")
        deleteReply?.resume(returning: Data(
            #"{"ok":true,"key":"agent:research:delete","deleted":true,"archived":[]}"#.utf8))
        _ = await deleteTask?.value
        #expect(batch.errors[OpenClawChatSessionSidebarData.identity(rows[0])] == "Restore failed")
    }
}
#endif
