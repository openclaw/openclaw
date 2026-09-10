import Foundation
import OpenClawKit
import OpenClawNativeState

/// App-only ownership. A permit fences publication, not Gateway authentication.
@MainActor
final class OpenClawWidgetCacheWriter {
    typealias Cache = OpenClawWidgetCache

    struct Permit: Sendable {
        let selection: String
        let owner: String
        let admission: String
        let epoch: String
        let ticket: Int64
        let admittedAt: Int64
        let expiresAt: Int64
    }

    private let database: OpenClawSQLiteConnection
    private var epoch = UUID().uuidString

    init(databaseURL: URL) throws {
        try OpenClawWidgetContainer.validateNoWALSidecars(databaseURL)
        let exists = FileManager.default.fileExists(atPath: databaseURL.path)
        if exists {
            try OpenClawWidgetContainer.validateDatabasePath(databaseURL)
            let reader = try OpenClawSQLiteConnection(databaseURL: databaseURL, access: .readOnly)
            try Cache.validateHeader(reader)
            try Cache.validate(reader)
        }
        try OpenClawWidgetContainer.prepareDirectory(for: databaseURL)
        try OpenClawWidgetContainer.validateNoWALSidecars(databaseURL)
        self.database = try OpenClawSQLiteConnection(
            databaseURL: databaseURL, access: .protectedReadWrite(createIfMissing: !exists))
        if exists {
            try Cache.validateHeader(self.database)
        } else {
            try self.database.execute("PRAGMA page_size = 4096; PRAGMA journal_mode = DELETE")
            try self.database.withImmediateTransaction {
                try self.database.execute(Self.schema)
            }
        }
        try Cache.validate(self.database)
        guard try self.database.scalarInt64("PRAGMA max_page_count = 256") == 256 else {
            throw Cache.Failure.capacity
        }
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS)
        attributes[.protectionKey] = FileProtectionType.complete
        #endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: databaseURL.path)
        var file = databaseURL
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try file.setResourceValues(resources)
        try self.database.withImmediateTransaction {
            let update = try self.database.prepare("UPDATE widget_meta SET writer_epoch = ? WHERE singleton_id = 1")
            try update.bindText(self.epoch, at: 1)
            _ = try update.step()
        }
    }

    func admitSelection(_ selection: Cache.Selection, label: String, now: Date) throws {
        let keys = try selection.keys()
        let time = try Cache.milliseconds(now)
        let subject: OpenClawWidgetSnapshot.Subject = if let run = selection.run {
            .run(run, sessionID: selection.generation, outcome: nil)
        } else {
            .session(selection.session, sessionID: selection.generation, state: .unknown)
        }
        let wire = try Cache.Wire(
            snapshot: .init(subject: subject, label: label, sourceRecordedAt: nil, queryObservedAt: now),
            now: now)
        let json = try wire.encoded()
        let admission = UUID().uuidString
        let bytes = Int64(json.utf8.count + keys.selection.utf8.count + keys.owner.utf8.count + admission.utf8.count)
        try self.database.withImmediateTransaction {
            try self.requireEpoch()
            if let row = try Cache.row(self.database, key: keys.selection) {
                guard time >= row.admittedAt, time < row.expiresAt else { throw Cache.Failure.expired }
                return
            }
            try self.pruneRows(nowMS: time)
            try self.makeRoom(bytes: bytes, excluding: keys.selection)
            let insert = try self.database.prepare("""
            INSERT INTO widget_snapshots
              (selection_key, owner_key, admission_id, payload_json, payload_bytes,
               admitted_at_ms, expires_at_ms, latest_ticket)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """)
            for (index, value) in [keys.selection, keys.owner, admission, json].enumerated() {
                try insert.bindText(value, at: Int32(index + 1))
            }
            try insert.bindInt64(bytes, at: 5)
            try insert.bindInt64(time, at: 6)
            try insert.bindInt64(time + Cache.lifetimeMS, at: 7)
            _ = try insert.step()
        }
    }

    func beginPublication(selection: Cache.Selection, now: Date) throws -> Permit {
        let keys = try selection.keys()
        let time = try Cache.milliseconds(now)
        return try self.database.withImmediateTransaction {
            try self.requireEpoch()
            guard let row = try Cache.row(self.database, key: keys.selection),
                  row.owner == keys.owner, time >= row.admittedAt, time < row.expiresAt
            else { throw Cache.Failure.expired }
            let next = try self.database.scalarInt64("SELECT next_ticket FROM widget_meta WHERE singleton_id = 1")
            guard next >= 0, next < Int64.max else { throw Cache.Failure.capacity }
            try self.database.execute("UPDATE widget_meta SET next_ticket = next_ticket + 1 WHERE singleton_id = 1")
            let update = try self.database
                .prepare("UPDATE widget_snapshots SET latest_ticket = ? WHERE selection_key = ?")
            try update.bindInt64(next + 1, at: 1)
            try update.bindText(keys.selection, at: 2)
            _ = try update.step()
            return Permit(
                selection: keys.selection,
                owner: keys.owner,
                admission: row.admission,
                epoch: self.epoch,
                ticket: next + 1,
                admittedAt: row.admittedAt,
                expiresAt: row.expiresAt)
        }
    }

    func publish(_ snapshot: OpenClawWidgetSnapshot, permit: Permit, now: Date) throws {
        let selection = Cache.Selection(subject: snapshot.subject)
        let keys = try selection.keys()
        let time = try Cache.milliseconds(now)
        let wire = try Cache.Wire(snapshot: snapshot, now: now)
        let json = try wire.encoded()
        guard keys.selection == permit.selection, keys.owner == permit.owner else {
            throw Cache.Failure.invalidPermit
        }
        try self.database.withImmediateTransaction {
            try self.requireEpoch()
            guard permit.epoch == self.epoch,
                  let row = try Cache.row(self.database, key: keys.selection),
                  row.owner == permit.owner, row.admission == permit.admission,
                  row.ticket == permit.ticket, permit.ticket > 0,
                  row.admittedAt == permit.admittedAt, row.expiresAt == permit.expiresAt
            else { throw Cache.Failure.invalidPermit }
            // Neither a fresh observation nor a transition from unknown extends admission.
            let expiry = min(row.expiresAt, wire.factAtMS.map { $0 + Cache.lifetimeMS } ?? row.expiresAt)
            guard time >= row.admittedAt, time < expiry else { throw Cache.Failure.expired }
            let old = try Cache.Wire.decode(row.json)
            if let oldFact = old.factAtMS, let newFact = wire.factAtMS, newFact < oldFact {
                throw Cache.Failure.invalidSnapshot
            }
            let bytes = Int64(json.utf8.count + keys.selection.utf8.count + keys.owner.utf8.count + row.admission.utf8
                .count)
            try self.makeRoom(bytes: bytes, excluding: keys.selection)
            let update = try self.database.prepare("""
            UPDATE widget_snapshots SET payload_json = ?, payload_bytes = ?, expires_at_ms = ?,
              latest_ticket = 0 WHERE selection_key = ? AND admission_id = ? AND latest_ticket = ?
            """)
            try update.bindText(json, at: 1)
            try update.bindInt64(bytes, at: 2)
            try update.bindInt64(expiry, at: 3)
            try update.bindText(keys.selection, at: 4)
            try update.bindText(permit.admission, at: 5)
            try update.bindInt64(permit.ticket, at: 6)
            _ = try update.step()
            guard self.database.changes == 1 else { throw Cache.Failure.invalidPermit }
        }
    }

    func invalidateOwner(_ owner: OpenClawNativeOwnerRef) throws {
        try self.invalidate(column: "owner_key", key: Cache.Selection.ownerKey(owner))
    }

    func invalidateSelection(_ selection: Cache.Selection) throws {
        try self.invalidate(column: "selection_key", key: selection.keys().selection)
    }

    func invalidateAll() throws {
        try self.invalidate(column: nil, key: nil)
    }

    func prune(now: Date) throws {
        let time = try Cache.milliseconds(now)
        try self.database.withImmediateTransaction {
            try self.requireEpoch()
            try self.pruneRows(nowMS: time)
        }
    }

    private func requireEpoch() throws {
        try Cache.validate(self.database)
        guard try self.database.scalarText("SELECT writer_epoch FROM widget_meta WHERE singleton_id = 1") == self.epoch
        else {
            throw Cache.Failure.invalidPermit
        }
    }

    private func invalidate(column: String?, key: String?) throws {
        let nextEpoch = UUID().uuidString
        try self.database.withImmediateTransaction {
            try self.requireEpoch()
            let update = try self.database.prepare("UPDATE widget_meta SET writer_epoch = ? WHERE singleton_id = 1")
            try update.bindText(nextEpoch, at: 1)
            _ = try update.step()
            if let column, let key {
                let deletion = try self.database.prepare("DELETE FROM widget_snapshots WHERE \(column) = ?")
                try deletion.bindText(key, at: 1)
                _ = try deletion.step()
            } else {
                try self.database.execute("DELETE FROM widget_snapshots")
            }
        }
        self.epoch = nextEpoch
    }

    private func pruneRows(nowMS: Int64) throws {
        let deletion = try self.database.prepare("DELETE FROM widget_snapshots WHERE expires_at_ms <= ?")
        try deletion.bindInt64(nowMS, at: 1)
        _ = try deletion.step()
    }

    private func makeRoom(bytes: Int64, excluding key: String) throws {
        guard bytes <= Cache.maximumBytes else { throw Cache.Failure.capacity }
        while true {
            let totals = try self.database.prepare("""
            SELECT COUNT(*), COALESCE(SUM(payload_bytes), 0) FROM widget_snapshots WHERE selection_key != ?
            """)
            try totals.bindText(key, at: 1)
            _ = try totals.step()
            if totals.int64(at: 0) < Cache.maximumRows, totals.int64(at: 1) + bytes <= Cache.maximumBytes {
                return
            }
            let deletion = try self.database.prepare("""
            DELETE FROM widget_snapshots WHERE selection_key = (
              SELECT selection_key FROM widget_snapshots WHERE selection_key != ?
              ORDER BY admitted_at_ms, selection_key LIMIT 1)
            """)
            try deletion.bindText(key, at: 1)
            _ = try deletion.step()
            guard self.database.changes == 1 else { throw Cache.Failure.capacity }
        }
    }

    private static let schema = """
    PRAGMA application_id = 0x4F435743;
    PRAGMA user_version = 1;
    CREATE TABLE widget_meta (
      singleton_id INTEGER NOT NULL PRIMARY KEY CHECK(singleton_id = 1),
      writer_epoch TEXT NOT NULL CHECK(length(writer_epoch) = 36),
      next_ticket INTEGER NOT NULL CHECK(next_ticket >= 0)
    ) STRICT;
    INSERT INTO widget_meta VALUES (1, '00000000-0000-0000-0000-000000000000', 0);
    CREATE TABLE widget_snapshots (
      selection_key TEXT NOT NULL PRIMARY KEY CHECK(length(selection_key) = 64),
      owner_key TEXT NOT NULL CHECK(length(owner_key) = 64),
      admission_id TEXT NOT NULL CHECK(length(admission_id) = 36),
      payload_json TEXT NOT NULL,
      payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0 AND payload_bytes <= 131072),
      admitted_at_ms INTEGER NOT NULL CHECK(admitted_at_ms >= 0),
      expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > admitted_at_ms),
      latest_ticket INTEGER NOT NULL CHECK(latest_ticket >= 0)
    ) STRICT;
    """
}
