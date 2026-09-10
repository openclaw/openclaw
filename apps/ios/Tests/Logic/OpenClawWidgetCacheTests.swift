import Foundation
import OpenClawKit
import OpenClawNativeState
import SQLite3
import Testing

@MainActor
struct OpenClawWidgetCacheTests {
    private typealias Cache = OpenClawWidgetCache
    private let now = Date(timeIntervalSince1970: 1_789_027_200)

    @Test func `latest issued permit wins and publication cannot recreate invalidated admission`() throws {
        try self.withCache { writer, url in
            let snapshot = self.snapshot()
            let selection = Cache.Selection(subject: snapshot.subject)
            try writer.admitSelection(selection, label: snapshot.label, now: self.now)
            let earlier = try writer.beginPublication(selection: selection, now: self.now)
            let latest = try writer.beginPublication(selection: selection, now: self.now)
            #expect(throws: Cache.Failure.invalidPermit) {
                try writer.publish(snapshot, permit: earlier, now: self.now)
            }
            try writer.publish(snapshot, permit: latest, now: self.now)
            #expect(throws: Cache.Failure.invalidPermit) {
                try writer.publish(snapshot, permit: latest, now: self.now)
            }
            let pending = try writer.beginPublication(selection: selection, now: self.now)
            try writer.invalidateSelection(selection)
            try writer.admitSelection(selection, label: "Explicit reselection", now: self.now)
            #expect(throws: Cache.Failure.invalidPermit) {
                try writer.publish(snapshot, permit: pending, now: self.now)
            }
            #expect(try self.read(url, selection: selection).label == "Explicit reselection")
        }
    }

    @Test func `reopening writer fences old handles and owner invalidation preserves unrelated expiry`() throws {
        try self.withCache { first, url in
            let selected = Cache.Selection(subject: self.snapshot().subject)
            let other = Cache.Selection(subject: self.snapshot(owner: "other").subject)
            try first.admitSelection(selected, label: "Selected", now: self.now)
            try first.admitSelection(other, label: "Other", now: self.now)
            let old = try first.beginPublication(selection: selected, now: self.now)
            let second = try OpenClawWidgetCacheWriter(databaseURL: url)
            #expect(throws: Cache.Failure.invalidPermit) {
                try first.publish(self.snapshot(), permit: old, now: self.now)
            }
            let fresh = try second.beginPublication(selection: other, now: self.now)
            try second.invalidateOwner(selected.session.owner)
            #expect(throws: Cache.Failure.invalidPermit) {
                try second.publish(self.snapshot(owner: "other"), permit: fresh, now: self.now)
            }
            #expect(self.isUnavailable(url, selection: selected))
            #expect(try self.read(url, selection: other).label == "Other")
            #expect(self.isUnavailable(url, selection: other, at: self.now.addingTimeInterval(86400)))
            try second.invalidateAll()
            #expect(self.isUnavailable(url, selection: other))
        }
    }

    @Test func `unknown to known and repeated observations never renew admission or fact deadline`() throws {
        try self.withCache { writer, url in
            let selection = Cache.Selection(subject: self.snapshot().subject)
            try writer.admitSelection(selection, label: "Research", now: self.now)
            let fact = self.now.addingTimeInterval(-3600)
            for elapsed in [0.0, 600.0, 3600.0] {
                let time = self.now.addingTimeInterval(elapsed)
                let permit = try writer.beginPublication(selection: selection, now: time)
                let snapshot = self.snapshot(fact: fact, observed: time)
                try writer.publish(snapshot, permit: permit, now: time)
                let actual = try self.read(url, selection: selection, at: time)
                #expect(actual.sourceRecordedAt == fact)
                #expect(actual.queryObservedAt == time)
            }
            #expect(!self.isUnavailable(url, selection: selection, at: self.now.addingTimeInterval(82799)))
            #expect(self.isUnavailable(url, selection: selection, at: self.now.addingTimeInterval(82800)))
            #expect(throws: Cache.Failure.expired) {
                try writer.admitSelection(
                    selection,
                    label: "Poll is not reselection",
                    now: self.now.addingTimeInterval(82800))
            }
            try writer.prune(now: self.now.addingTimeInterval(82800))
            #expect(try self.database(url).scalarInt64("SELECT COUNT(*) FROM widget_snapshots") == 0)
        }
    }

    @Test(arguments: [
        OpenClawWidgetSnapshot.TerminalOutcome.completed, .failed, .cancelled, .timedOut,
    ])
    func `selected run terminal facts round trip without aggregate inference`(
        outcome: OpenClawWidgetSnapshot.TerminalOutcome) throws
    {
        try self.withCache { writer, url in
            let session = Cache.Selection(subject: self.snapshot().subject).session
            let subject = OpenClawWidgetSnapshot.Subject.run(
                .init(session: session, runID: "selected\u{0}run"),
                sessionID: "generation",
                outcome: outcome)
            let snapshot = OpenClawWidgetSnapshot(
                subject: subject, label: "Release review", sourceRecordedAt: self.now, queryObservedAt: self.now)
            let selection = Cache.Selection(subject: subject)
            try writer.admitSelection(selection, label: snapshot.label, now: self.now)
            let unknown = try self.read(url, selection: selection)
            guard case let .run(unknownRun, unknownGeneration, unknownOutcome) = unknown.subject else {
                Issue.record("Selected run became a conversation")
                return
            }
            #expect(unknownRun.runID == "selected\u{0}run")
            #expect(unknownGeneration == "generation")
            #expect(unknownOutcome == nil)
            try writer.publish(
                snapshot,
                permit: writer.beginPublication(selection: selection, now: self.now),
                now: self.now)
            guard case let .run(actualRun, generation, actualOutcome) = try self.read(url, selection: selection)
                .subject
            else {
                Issue.record("Selected run became a conversation")
                return
            }
            #expect(actualRun.session == session)
            #expect(actualRun.runID == "selected\u{0}run")
            #expect(generation == "generation")
            #expect(actualOutcome == outcome)
        }
    }

    @Test(arguments: ["shortened", "exact", "expanded", "maximum"])
    func `persisted expiry cannot extend an unknown admission beyond twenty four hours`(deadline: String) throws {
        try self.withCache { writer, url in
            let selection = Cache.Selection(subject: self.snapshot().subject)
            try writer.admitSelection(selection, label: "Research", now: self.now)
            let unknown = try self.read(url, selection: selection)
            try #require(unknown.sourceRecordedAt == nil)
            guard case .session(_, _, .unknown) = unknown.subject else {
                Issue.record("Fixture must remain an unknown conversation")
                return
            }
            let admittedAt = Int64(self.now.timeIntervalSince1970 * 1000)
            let expiry: Int64 = switch deadline {
            case "shortened": admittedAt + 3_600_000
            case "exact": admittedAt + 86_400_000
            case "expanded": admittedAt + 172_800_000
            case "maximum": Int64.max
            default: preconditionFailure("Unknown fixture")
            }
            let database = try self.database(url)
            let update = try database.prepare("UPDATE widget_snapshots SET expires_at_ms = ?")
            try update.bindInt64(expiry, at: 1)
            _ = try update.step()

            if deadline == "shortened" || deadline == "exact" {
                let before = self.now.addingTimeInterval(deadline == "shortened" ? 3599 : 86399)
                #expect(!self.isUnavailable(url, selection: selection, at: before))
                _ = try writer.beginPublication(selection: selection, now: before)
                try writer.admitSelection(selection, label: "Still admitted", now: before)
            }
            let nextTicket = try database.scalarInt64("SELECT next_ticket FROM widget_meta")
            let latestTicket = try database.scalarInt64("SELECT latest_ticket FROM widget_snapshots")
            let offsets: [TimeInterval] = deadline == "shortened" ? [3600, 86400, 86401] : [86400, 86401]
            for offset in offsets {
                let time = self.now.addingTimeInterval(offset)
                let unavailable = self.isUnavailable(url, selection: selection, at: time)
                #expect(unavailable)
                for issueTicket in [true, false] {
                    #expect(throws: (any Error).self) {
                        if issueTicket {
                            _ = try writer.beginPublication(selection: selection, now: time)
                        } else {
                            try writer.admitSelection(selection, label: "Not a new admission", now: time)
                        }
                    }
                    #expect(try database.scalarInt64("SELECT next_ticket FROM widget_meta") == nextTicket)
                    #expect(try database.scalarInt64("SELECT latest_ticket FROM widget_snapshots") == latestTicket)
                    #expect(try database.scalarInt64("SELECT admitted_at_ms FROM widget_snapshots") == admittedAt)
                    #expect(try database.scalarInt64("SELECT expires_at_ms FROM widget_snapshots") == expiry)
                }
            }
        }
    }

    @Test func `escaped identifiers preserve exact bytes and owner routes are not stored`() throws {
        try self.withCache { writer, url in
            for key in ["e\u{301}", "\u{e9}", "left\u{0}right"] {
                let snapshot = self.snapshot(key: key, owner: "https://gateway.example.test/private-route")
                let selection = Cache.Selection(subject: snapshot.subject)
                try writer.admitSelection(selection, label: key, now: self.now)
                try writer.publish(
                    snapshot,
                    permit: writer.beginPublication(selection: selection, now: self.now),
                    now: self.now)
                let restored = try Cache.Selection(subject: self.read(url, selection: selection).subject)
                #expect(restored.session.sessionKey.utf8.elementsEqual(key.utf8))
            }
            let database = try self.database(url)
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM widget_snapshots") == 3)
            let bytes = try Data(contentsOf: url)
            #expect(bytes.range(of: Data("private-route".utf8)) == nil)
            let invalid = Cache.Selection(subject: self.snapshot(key: String(repeating: "x", count: 2049)).subject)
            #expect(throws: Cache.Failure.invalidSelection) {
                try writer.admitSelection(invalid, label: "Too long", now: self.now)
            }
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM widget_snapshots") == 3)
        }
    }

    @Test func `all admissions count toward row and actual escaped payload byte budgets`() throws {
        try self.withCache { writer, url in
            let first = Cache.Selection(subject: self.snapshot(key: "0").subject)
            for index in 0..<65 {
                let selection = Cache.Selection(subject: self.snapshot(key: "\(index)").subject)
                try writer.admitSelection(selection, label: "Pending", now: self.now.addingTimeInterval(Double(index)))
            }
            let database = try self.database(url)
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM widget_snapshots") == 64)
            #expect(self.isUnavailable(url, selection: first, at: self.now.addingTimeInterval(65)))
            try writer.invalidateAll()
            for index in 0..<64 {
                let selection = Cache.Selection(subject: self.snapshot(
                    key: "\(index)" + String(repeating: "\u{0}", count: 2000)).subject)
                try writer.admitSelection(selection, label: String(repeating: "\u{0}", count: 96), now: self.now)
            }
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM widget_snapshots") < 64)
            #expect(try database.scalarInt64("SELECT SUM(payload_bytes) FROM widget_snapshots") <= 131_072)
            try Cache.validate(database)
        }
    }

    @Test func `privacy and invalid owner suppress storage while missing timestamps remain unknown`() throws {
        try self.withCache { writer, url in
            let selection = Cache.Selection(subject: self.snapshot().subject)
            try writer.admitSelection(selection, label: "Private research", now: self.now)
            for fact in [nil, Date(timeIntervalSince1970: .nan), self.now.addingTimeInterval(1)] {
                let snapshot = self.snapshot(fact: fact)
                try writer.publish(
                    snapshot,
                    permit: writer.beginPublication(selection: selection, now: self.now),
                    now: self.now)
                #expect(try self.read(url, selection: selection).sourceRecordedAt == nil)
            }
            let reader = Cache.Reader(databaseURL: url)
            for privacy in [OpenClawWidgetPresentation.Privacy.locked, .hidden] {
                guard case .unavailable = reader.read(
                    selection: selection, now: self.now, privacy: privacy, availability: .connected)
                else { Issue.record("Privacy exposed cache contents")
                    continue
                }
            }
            for availability in [
                OpenClawWidgetPresentation.Availability.ownerInvalidated,
                .permissionDenied,
                .unavailable,
            ] {
                guard case .unavailable = reader.read(
                    selection: selection, now: self.now, privacy: .visible, availability: availability)
                else { Issue.record("Unavailable owner exposed cache contents")
                    continue
                }
            }
            #expect(try self.read(url, selection: selection).label == "Research")
        }
    }

    @Test func `unknown newer corrupt busy and oversized stores remain unavailable without reconstruction`() throws {
        try self.withCache { writer, url in
            let selection = Cache.Selection(subject: self.snapshot().subject)
            try writer.admitSelection(selection, label: "Research", now: self.now)
            let database = try self.database(url)
            try database.execute("BEGIN EXCLUSIVE")
            #expect(self.isUnavailable(url, selection: selection))
            #expect(throws: (any Error).self) { try OpenClawWidgetCacheWriter(databaseURL: url) }
            try database.execute("ROLLBACK")
            for version in [2, 0] {
                try database.execute("PRAGMA user_version = \(version)")
                let before = try Data(contentsOf: url)
                #expect(self.isUnavailable(url, selection: selection))
                #expect(throws: (any Error).self) { try OpenClawWidgetCacheWriter(databaseURL: url) }
                #expect(try Data(contentsOf: url) == before)
            }
            try database.execute("PRAGMA user_version = 1")
            try database.execute("UPDATE widget_snapshots SET payload_json = printf('%.*c', 131073, 'x')")
            #expect(self.isUnavailable(url, selection: selection))
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        try Data("Not a SQLite cache".utf8).write(to: url)
        let before = try Data(contentsOf: url)
        #expect(throws: (any Error).self) { try OpenClawWidgetCacheWriter(databaseURL: url) }
        #expect(try Data(contentsOf: url) == before)
    }

    @Test(arguments: [false, true], [false, true])
    func `unsupported WAL admission cannot create sidecars`(throughWriter: Bool, retainWAL: Bool) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        let selection = Cache.Selection(subject: self.snapshot().subject)
        var writer: OpenClawWidgetCacheWriter? = try OpenClawWidgetCacheWriter(databaseURL: url)
        try writer?.admitSelection(selection, label: "Research", now: self.now)
        writer = nil
        try self.leaveWAL(at: url, retainWAL: retainWAL)
        let walURL = directory.appendingPathComponent(Cache.filename + "-wal")
        let beforeNames = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        let expectedNames = retainWAL ? [Cache.filename, Cache.filename + "-wal"] : [Cache.filename]
        try #require(beforeNames == expectedNames)
        try #require(FileManager.default.isWritableFile(atPath: directory.path))
        let beforeBytes = try Data(contentsOf: url)
        let beforeWAL = retainWAL ? try Data(contentsOf: walURL) : nil
        let beforeMetadata = try beforeNames.map {
            try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent($0).path) as NSDictionary
        }
        try #require(beforeBytes.count >= 100 && beforeBytes[18] == 2 && beforeBytes[19] == 2)

        let category: String
        if throughWriter {
            do {
                _ = try OpenClawWidgetCacheWriter(databaseURL: url)
                category = "accepted"
            } catch let failure as Cache.Failure {
                category = "cache.\(failure)"
            } catch is OpenClawNativeStateError {
                category = "sqlite-error"
            } catch {
                category = "other-error"
            }
        } else {
            category = self.isUnavailable(url, selection: selection) ? "cache.unavailable" : "accepted"
        }

        let afterNames = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        let afterBytes = try? Data(contentsOf: url)
        let afterWAL = retainWAL ? try? Data(contentsOf: walURL) : nil
        print(
            "WAL admission: writer=\(throughWriter), retainedWAL=\(retainWAL), category=\(category)"
                + ", files=\(afterNames)")
        #expect(category != "accepted")
        #expect(afterNames == beforeNames)
        #expect(afterBytes == beforeBytes)
        #expect(afterWAL == beforeWAL)
        for (name, attributes) in zip(beforeNames, beforeMetadata) {
            #expect(try FileManager.default
                .attributesOfItem(atPath: directory.appendingPathComponent(name).path) as NSDictionary == attributes)
        }
    }

    @Test func `rollback header cannot admit a retained WAL`() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        _ = try OpenClawWidgetCacheWriter(databaseURL: url)
        try self.leaveWAL(at: url, retainWAL: true)
        var bytes = try Data(contentsOf: url)
        bytes[18] = 1
        bytes[19] = 1
        try bytes.write(to: url)
        try self.expectUnavailableUnchanged(url)
    }

    @Test(arguments: ["rollback", "orphan", "dangling-rollback", "dangling-orphan"], ["-wal", "-shm"])
    func `unsupported sidecar entries are never opened or replaced`(kind: String, suffix: String) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        if kind.hasSuffix("rollback") {
            _ = try OpenClawWidgetCacheWriter(databaseURL: url)
        }
        let sidecar = directory.appendingPathComponent(Cache.filename + suffix)
        if kind.hasPrefix("dangling") {
            try FileManager.default.createSymbolicLink(atPath: sidecar.path, withDestinationPath: "absent")
        } else {
            try Data("Unsupported sidecar".utf8).write(to: sidecar)
        }
        try self.expectUnavailableUnchanged(url)
    }

    @Test(arguments: [
        "empty", "truncated", "magic", "mixed-read", "mixed-write", "unknown-mode",
        "page-size", "application-id", "user-version",
    ])
    func `existing incompatible headers are not treated as fresh caches`(kind: String) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        _ = try OpenClawWidgetCacheWriter(databaseURL: url)
        var bytes = try Data(contentsOf: url)
        switch kind {
        case "empty": bytes = Data()
        case "truncated": bytes = bytes.prefix(99)
        case "magic": bytes[0] = 0
        case "mixed-read": bytes[19] = 2
        case "mixed-write": bytes[18] = 2
        case "unknown-mode": bytes[18] = 3
            bytes[19] = 3
        case "page-size": bytes[16] = 0x20
        case "application-id": bytes[68] = 0
        case "user-version": bytes[63] = 2
        default: preconditionFailure("Unknown fixture")
        }
        try bytes.write(to: url)
        try self.expectUnavailableUnchanged(url)
    }

    @Test func `missing cache reader leaves storage absent`() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = directory.appendingPathComponent(Cache.filename)
        #expect(self.isUnavailable(url, selection: .init(subject: self.snapshot().subject)))
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    @Test func `sidecar lookup errors are not missing storage`() throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let bytes = Data("Not a directory".utf8)
        try bytes.write(to: parent)
        let url = parent.appendingPathComponent(Cache.filename)
        #expect(self.isUnavailable(url, selection: .init(subject: self.snapshot().subject)))
        #expect(throws: Cache.Failure.unavailable) { try OpenClawWidgetCacheWriter(databaseURL: url) }
        #expect(try Data(contentsOf: parent) == bytes)
    }

    @Test func `closed payload rejects extra fields mismatched identity and embedded raw nul`() throws {
        try self.withCache { writer, url in
            let selection = Cache.Selection(subject: self.snapshot().subject)
            try writer.admitSelection(selection, label: "Research", now: self.now)
            let database = try self.database(url)
            let original = try #require(try database.scalarText("SELECT payload_json FROM widget_snapshots"))
            var fields = try #require(try JSONSerialization.jsonObject(with: Data(original.utf8)) as? [String: Any])
            fields["endpointURL"] = "https://example.test"
            let extra = try #require(try String(data: JSONSerialization.data(withJSONObject: fields), encoding: .utf8))
            fields.removeValue(forKey: "endpointURL")
            fields["generation"] = "other"
            let mismatch = try #require(try String(
                data: JSONSerialization.data(withJSONObject: fields),
                encoding: .utf8))
            for json in [extra, mismatch] {
                let update = try database.prepare("UPDATE widget_snapshots SET payload_json = ?")
                try update.bindText(json, at: 1)
                _ = try update.step()
                try database.execute("""
                UPDATE widget_snapshots SET payload_bytes = length(CAST(payload_json AS BLOB)) + 164
                """)
                #expect(self.isUnavailable(url, selection: selection))
            }
            let reset = try database.prepare("UPDATE widget_snapshots SET payload_json = ? || char(0) || 'hidden'")
            try reset.bindText(original, at: 1)
            _ = try reset.step()
            try database.execute("UPDATE widget_snapshots SET payload_bytes = length(CAST(payload_json AS BLOB)) + 164")
            #expect(self.isUnavailable(url, selection: selection))
        }
    }

    private func snapshot(
        key: String = "selected",
        owner: String = "gateway",
        fact: Date? = nil,
        observed: Date? = nil) -> OpenClawWidgetSnapshot
    {
        let session = OpenClawNativeSessionRef(
            owner: .init(gatewayID: owner, profileID: "profile"), agentID: "main", sessionKey: key)
        return .init(
            subject: .session(session, sessionID: "generation", state: .running),
            label: "Research",
            sourceRecordedAt: fact,
            queryObservedAt: observed ?? self.now)
    }

    private func database(_ url: URL) throws -> OpenClawSQLiteConnection {
        try OpenClawSQLiteConnection(databaseURL: url, access: .readWrite(createIfMissing: false))
    }

    private func read(_ url: URL, selection: Cache.Selection, at time: Date? = nil) throws -> OpenClawWidgetSnapshot {
        let result = Cache.Reader(databaseURL: url).read(
            selection: selection, now: time ?? self.now, privacy: .visible, availability: .offline)
        guard case let .snapshot(snapshot) = result else { throw Cache.Failure.unavailable }
        return snapshot
    }

    private func isUnavailable(_ url: URL, selection: Cache.Selection, at time: Date? = nil) -> Bool {
        if case .unavailable = Cache.Reader(databaseURL: url).read(
            selection: selection, now: time ?? self.now, privacy: .visible, availability: .connected) { return true }
        return false
    }

    private func leaveWAL(at url: URL, retainWAL: Bool) throws {
        var fixture: OpaquePointer?
        try #require(sqlite3_open_v2(url.path, &fixture, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
        let database = try #require(fixture)
        var persistWAL: Int32 = retainWAL ? 1 : 0
        let cleanupConfigured = sqlite3_file_control(database, nil, SQLITE_FCNTL_PERSIST_WAL, &persistWAL)
        let configured = sqlite3_exec(
            database, "PRAGMA journal_mode = WAL; UPDATE widget_meta SET next_ticket = 1", nil, nil, nil)
        let closed = sqlite3_close(database)
        try #require(cleanupConfigured == SQLITE_OK && configured == SQLITE_OK && closed == SQLITE_OK)
        if retainWAL {
            let wal = URL(fileURLWithPath: url.path + "-wal")
            let shm = URL(fileURLWithPath: url.path + "-shm")
            try #require(FileManager.default.fileExists(atPath: wal.path))
            try #require(FileManager.default.fileExists(atPath: shm.path))
            // Remove only this fixture's SHM after every handle closes.
            try FileManager.default.removeItem(at: shm)
        }
    }

    /// Every caller closes fixture handles first. Never read/close a separate
    /// main-file descriptor while SQLite might hold a POSIX lock.
    private func expectUnavailableUnchanged(_ url: URL) throws {
        let manager = FileManager.default
        let directory = url.deletingLastPathComponent()
        let names = try manager.contentsOfDirectory(atPath: directory.path).sorted()
        var bytes: [String: Data] = [:]
        var links: [String: String] = [:]
        var metadata: [String: NSDictionary] = [:]
        for name in names {
            let file = directory.appendingPathComponent(name)
            let attributes = try manager.attributesOfItem(atPath: file.path)
            metadata[name] = attributes as NSDictionary
            if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                links[name] = try manager.destinationOfSymbolicLink(atPath: file.path)
            } else {
                bytes[name] = try Data(contentsOf: file)
            }
        }
        #expect(self.isUnavailable(url, selection: .init(subject: self.snapshot().subject)))
        #expect(throws: (any Error).self) { try OpenClawWidgetCacheWriter(databaseURL: url) }
        #expect(try manager.contentsOfDirectory(atPath: directory.path).sorted() == names)
        for name in names {
            let file = directory.appendingPathComponent(name)
            #expect(try manager.attributesOfItem(atPath: file.path) as NSDictionary == metadata[name])
            if let target = links[name] {
                #expect(try manager.destinationOfSymbolicLink(atPath: file.path) == target)
            } else {
                #expect(try Data(contentsOf: file) == bytes[name])
            }
        }
    }

    private func withCache(_ operation: (OpenClawWidgetCacheWriter, URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent(Cache.filename)
        try operation(OpenClawWidgetCacheWriter(databaseURL: url), url)
    }
}
