import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClawChatUI

private func makeDatabaseURL() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-cache-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("chat-cache.sqlite", isDirectory: false)
}

private func cacheMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> OpenClawChatMessage
{
    OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp,
        idempotencyKey: idempotencyKey)
}

private func cacheSessionEntry(key: String, updatedAt: Double) -> OpenClawChatSessionEntry {
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: updatedAt,
        sessionId: nil,
        systemSent: nil,
        abortedLastRun: nil,
        thinkingLevel: nil,
        verboseLevel: nil,
        inputTokens: nil,
        outputTokens: nil,
        totalTokens: nil,
        modelProvider: nil,
        model: nil,
        contextTokens: nil)
}

private func messageTexts(_ messages: [OpenClawChatMessage]) -> [String] {
    messages.map { $0.content.compactMap(\.text).joined() }
}

struct ChatTranscriptCacheStoreTests {
    @Test func `transcript and sessions round trip`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let messages = [
            cacheMessage(role: "user", text: "hello", timestamp: 1000, idempotencyKey: "run-1:user"),
            cacheMessage(role: "assistant", text: "hi there", timestamp: 2000, idempotencyKey: "run-1"),
        ]
        await store.storeTranscript(sessionKey: "main", messages: messages)
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 2000)])

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(messageTexts(loaded) == ["hello", "hi there"])
        #expect(loaded.map(\.role) == ["user", "assistant"])
        #expect(loaded.map(\.idempotencyKey) == ["run-1:user", "run-1"])
        #expect(loaded.map(\.timestamp) == [1000, 2000])

        let sessions = await store.loadSessions()
        #expect(sessions.map(\.key) == ["main"])

        #expect(await store.loadTranscript(sessionKey: "unknown").isEmpty)
    }

    @Test func `transcript keeps only most recent messages within bound`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedMessagesPerSession

        let messages = (0..<(bound + 50)).map { index in
            cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))
        }
        await store.storeTranscript(sessionKey: "main", messages: messages)

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(loaded.count == bound)
        #expect(messageTexts(loaded).first == "m50")
        #expect(messageTexts(loaded).last == "m\(bound + 49)")
    }

    @Test func `sessions list is bounded to most recently updated`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedSessions

        let sessions = (0..<(bound + 10)).map { index in
            cacheSessionEntry(key: "s\(index)", updatedAt: Double(index))
        }
        await store.storeSessions(sessions)

        let loaded = await store.loadSessions()
        #expect(loaded.count == bound)
        // Highest updatedAt survives, oldest entries are dropped.
        #expect(loaded.map(\.key).contains("s\(bound + 9)"))
        #expect(!loaded.map(\.key).contains("s0"))
    }

    @Test func `transcript eviction keeps most recent sessions`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedTranscripts

        for index in 0..<(bound + 5) {
            await store.storeTranscript(
                sessionKey: "s\(index)",
                messages: [cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))])
        }

        // The five oldest transcripts were evicted; the newest ones remain.
        for index in 0..<5 {
            #expect(await store.loadTranscript(sessionKey: "s\(index)").isEmpty)
        }
        for index in 5..<(bound + 5) {
            #expect(await !(store.loadTranscript(sessionKey: "s\(index)").isEmpty))
        }
    }

    @Test func `transcripts are scoped per gateway identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")

        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A secret", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])

        #expect(await storeB.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeB.loadSessions().isEmpty)

        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])
        #expect(await messageTexts(storeA.loadTranscript(sessionKey: "main")) == ["gateway A secret"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "main")) == ["gateway B"])
    }

    @Test func `empty transcript store clears cached row`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "old", timestamp: 1)])
        await store.storeTranscript(sessionKey: "main", messages: [])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `reset retirement permits physical removal of all gateway rows`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        await storeB.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: url)
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "late write", timestamp: 3)])

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let readerB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        #expect(await storeA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await readerB.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `removing one gateway database preserves another`() async throws {
        let urlA = try makeDatabaseURL()
        let directory = urlA.deletingLastPathComponent()
        let urlB = directory.appendingPathComponent("chat-cache-b.sqlite", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: urlB, gatewayID: "gw-b")
        await storeA.storeSessions([cacheSessionEntry(key: "a", updatedAt: 1)])
        await storeA.storeTranscript(
            sessionKey: "a",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeB.storeSessions([cacheSessionEntry(key: "b", updatedAt: 2)])
        await storeB.storeTranscript(
            sessionKey: "b",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: urlA)

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        #expect(await readerA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "a").isEmpty)
        #expect(await storeB.loadSessions().map(\.key) == ["b"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "b")) == ["gateway B"])
    }

    @Test func `attachment payloads are not persisted`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let message = OpenClawChatMessage(
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "See attached.",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
                OpenClawChatMessageContent(
                    type: "image",
                    text: nil,
                    mimeType: "image/png",
                    fileName: "photo.png",
                    content: AnyCodable("aGVsbG8tYmluYXJ5LWJsb2I=")),
            ],
            timestamp: 1000)
        await store.storeTranscript(sessionKey: "main", messages: [message])

        let loaded = await store.loadTranscript(sessionKey: "main")
        let items = try #require(loaded.first?.content)
        #expect(items.count == 2)
        // Text and small descriptors survive; binary payloads never hit disk.
        #expect(items[0].text == "See attached.")
        #expect(items[1].fileName == "photo.png")
        #expect(items[1].content == nil)
    }

    @Test func `schema version mismatch drops and rebuilds silently`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            await store.storeTranscript(
                sessionKey: "main",
                messages: [cacheMessage(role: "user", text: "old-schema", timestamp: 1)])
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 99", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let rebuilt = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await rebuilt.loadTranscript(sessionKey: "main").isEmpty)

        // Rebuilt store is fully functional again.
        await rebuilt.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "fresh", timestamp: 2)])
        #expect(await messageTexts(rebuilt.loadTranscript(sessionKey: "main")) == ["fresh"])
    }

    @Test func `corrupt database file drops and rebuilds silently`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        try Data("this is not a sqlite database".utf8).write(to: url)

        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "recovered", timestamp: 1)])
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["recovered"])
    }

    @Test func `undecodable row is dropped and treated as miss`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "seed", timestamp: 1)])

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "UPDATE cached_transcripts SET payload = '{not json' WHERE session_key = 'main'",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let reader = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
        // The bad row was deleted, not just skipped.
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
    }
}
