import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

struct SharedDraftInboxTests {
    @Test func `preserves original mixed share across reopen and cleans only explicitly`() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let names = ["report.pdf", "clip.mov", "1.png", "2.png", "3.png", "4.png"]
        var urls: [URL] = []
        for (index, name) in names.enumerated() {
            let url = directory.appendingPathComponent(name)
            try Data([0, UInt8(index), 255]).write(to: url)
            urls.append(url)
        }
        let target = SharedDraftTarget(
            gatewayID: "gateway-original", agentID: "research", sessionKey: "agent:research:notes")
        let now = Date(timeIntervalSince1970: 1000)
        let dbURL = directory.appendingPathComponent("inbox")
        let inbox = SharedDraftInbox(directoryURL: dbURL)
        try await inbox.setDestination(target)
        let id = try await inbox.save(text: "Original\n\nText: details\u{0000}末", target: target, files: urls, now: now)
        let reopened = SharedDraftInbox(directoryURL: dbURL)
        try await reopened.setDestination(.init(gatewayID: "other", agentID: "main", sessionKey: "main"))
        let saved = try #require(try await reopened.pending(now: now).first)
        #expect(saved.target == target)
        #expect(saved.text == "Original\n\nText: details\u{0000}末")
        #expect(saved.fileNames == names)
        let copies = try await reopened.materialize(id: id, into: directory.appendingPathComponent("copies"), now: now)
        for (index, copy) in copies.enumerated() {
            #expect(try Data(contentsOf: copy) == Data([0, UInt8(index), 255]))
        }
        // Materialization/review/cancellation are not acceptance or deletion.
        #expect(try await reopened.pending(now: now).count == 1)
        try await reopened.discard(id: id)
        #expect(try await inbox.pending(now: now).isEmpty)
    }

    @Test func `rejects whole unreadable or over budget share and expires at 48 hours`() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let inbox = SharedDraftInbox(directoryURL: directory)
        let target = SharedDraftTarget(gatewayID: "gateway", agentID: "main", sessionKey: "main")
        let now = Date(timeIntervalSince1970: 1000)
        let id = try await inbox.save(text: "Keep me", target: target, files: [], now: now)
        do {
            try await inbox.save(
                text: "Must roll back",
                target: target,
                files: [directory.appendingPathComponent("missing.pdf")],
                now: now)
            Issue.record("Unreadable item was accepted")
        } catch {}
        do {
            try await inbox.save(
                text: String(repeating: "x", count: 128 * 1024 + 1),
                target: target,
                files: [],
                now: now)
            Issue.record("Oversized text was accepted")
        } catch {}
        let oversized = directory.appendingPathComponent("too-large.pdf")
        FileManager.default.createFile(atPath: oversized.path, contents: nil)
        let handle = try FileHandle(forWritingTo: oversized)
        try handle.truncate(atOffset: UInt64(SharedDraftInbox.maximumBytes + 1))
        try handle.close()
        for files in [[oversized], Array(repeating: oversized, count: 51)] {
            do {
                try await inbox.save(text: "Must not omit", target: target, files: files, now: now)
                Issue.record("Oversized item selection was accepted")
            } catch {}
        }
        let beforeExpiry = try await inbox.pending(now: now.addingTimeInterval(48 * 60 * 60 - 1))
        #expect(beforeExpiry.map(\.id) == [id])
        #expect(try await inbox.pending(now: now.addingTimeInterval(48 * 60 * 60)).isEmpty)
    }
}

extension SharedDraftInboxTests {
    @Test func `opens through ancestor aliases but rejects database file symlinks`() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let physical = root.appendingPathComponent("physical")
        try FileManager.default.createDirectory(at: physical, withIntermediateDirectories: true)
        let alias = root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: physical)
        let inbox = SharedDraftInbox(directoryURL: alias.appendingPathComponent("inbox"))
        let target = SharedDraftTarget(gatewayID: "gateway", agentID: "main", sessionKey: "main")
        let id = try await inbox.save(text: "Keep this draft", target: target, files: [])
        let reopened = SharedDraftInbox(directoryURL: physical.appendingPathComponent("inbox"))
        #expect(try await reopened.pending().map(\.id) == [id])
        let foreign = root.appendingPathComponent("foreign")
        try FileManager.default.createDirectory(at: foreign, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: foreign.appendingPathComponent("inbox.sqlite"),
            withDestinationURL: physical.appendingPathComponent("inbox/inbox.sqlite"))
        let linkedDatabase = SharedDraftInbox(directoryURL: foreign)
        await #expect(throws: SharedDraftError.self) { try await linkedDatabase.pending() }
        #expect(try await reopened.pending().map(\.id) == [id])
    }
}

extension SharedDraftInboxTests {
    @Test @MainActor func `rejects invalid stored UTF 8 without deleting the share`() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let inbox = SharedDraftInbox(directoryURL: directory)
        let target = SharedDraftTarget(gatewayID: "gateway", agentID: "main", sessionKey: "main")
        let now = Date(timeIntervalSince1970: 1000)
        let id = try await inbox.save(text: "Original", target: target, files: [], now: now)
        var opened: OpaquePointer?
        try #require(sqlite3_open(directory.appendingPathComponent("inbox.sqlite").path, &opened) == SQLITE_OK)
        let database = try #require(opened)
        defer { sqlite3_close(database) }
        // SQLite permits invalid UTF-8 in TEXT; the Swift producer never emits it.
        try #require(sqlite3_exec(database, "UPDATE imports SET text=CAST(X'80' AS TEXT)", nil, nil, nil) == SQLITE_OK)
        await #expect(throws: SharedDraftError.self) { try await inbox.pending(now: now) }
        try #require(sqlite3_exec(database, "UPDATE imports SET text='restored'", nil, nil, nil) == SQLITE_OK)
        #expect(sqlite3_changes(database) == 1)
        let retained = try #require(try await inbox.pending(now: now).first)
        #expect(retained.id == id)
        #expect(retained.text == "restored")
        #expect(retained.target == target)
    }
}
