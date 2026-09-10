import CryptoKit
import Foundation
import OpenClawKit
import OpenClawNativeState

enum OpenClawWidgetCache {
    static let maximumRows: Int64 = 64
    static let maximumBytes: Int64 = 128 * 1024
    static let lifetimeMS: Int64 = 24 * 60 * 60 * 1000
    static let staleAfter: TimeInterval = 5 * 60
    static let applicationID: Int64 = 0x4F43_5743
    static let filename = "widget-cache.sqlite"

    enum Failure: Error {
        case unavailable, incompatible, invalidSelection, invalidSnapshot, invalidPermit, expired, capacity
    }

    struct Selection: Sendable {
        let session: OpenClawNativeSessionRef
        let generation: String
        let run: OpenClawNativeRunRef?

        init(subject: OpenClawWidgetSnapshot.Subject) {
            switch subject {
            case let .session(session, generation, _):
                self.session = session
                self.generation = generation
                self.run = nil
            case let .run(run, generation, _):
                self.session = run.session
                self.generation = generation
                self.run = run
            }
        }

        func keys() throws -> (selection: String, owner: String) {
            let owner = [self.session.owner.gatewayID, self.session.owner.profileID]
            let identifiers = owner + [self.session.agentID, self.session.sessionKey, self.generation]
                + (self.run.map { [$0.runID] } ?? [])
            let limits = [4096, 512, 64, 2048, 512] + (self.run == nil ? [] : [1024])
            guard zip(identifiers, limits).allSatisfy({ !$0.0.isEmpty && $0.0.utf8.count <= $0.1 }) else {
                throw Failure.invalidSelection
            }
            // Arrays delimit exact UTF-8 identifiers without persisting route URLs.
            // These digests select rows; they confer no connection authority.
            return try (
                Self.digest(identifiers + [self.run == nil ? "conversation" : "run"]),
                Self.ownerKey(self.session.owner))
        }

        static func ownerKey(_ owner: OpenClawNativeOwnerRef) throws -> String {
            guard !owner.gatewayID.isEmpty, owner.gatewayID.utf8.count <= 4096,
                  !owner.profileID.isEmpty, owner.profileID.utf8.count <= 512
            else { throw Failure.invalidSelection }
            return try self.digest([owner.gatewayID, owner.profileID])
        }

        private static func digest(_ fields: [String]) throws -> String {
            let bytes = try JSONEncoder().encode(fields)
            return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
    }

    enum ReadResult {
        case snapshot(OpenClawWidgetSnapshot)
        case unavailable
    }

    struct Reader {
        let databaseURL: URL

        func read(
            selection: Selection,
            now: Date,
            privacy: OpenClawWidgetPresentation.Privacy,
            availability: OpenClawWidgetPresentation.Availability) -> ReadResult
        {
            guard case .visible = privacy else { return .unavailable }
            switch availability {
            case .connected, .offline: break
            case .unavailable, .permissionDenied, .ownerInvalidated: return .unavailable
            }
            do {
                let keys = try selection.keys()
                let time = try OpenClawWidgetCache.milliseconds(now)
                try OpenClawWidgetContainer.validateDatabasePath(self.databaseURL)
                let database = try OpenClawSQLiteConnection(databaseURL: self.databaseURL, access: .readOnly)
                try OpenClawWidgetCache.validateHeader(database)
                try OpenClawWidgetCache.validate(database)
                guard let row = try OpenClawWidgetCache.row(database, key: keys.selection),
                      row.owner == keys.owner, time >= row.admittedAt, time < row.expiresAt
                else { return .unavailable }
                let wire = try Wire.decode(row.json)
                let snapshot = try wire.snapshot(selection: selection, nowMS: time)
                return .snapshot(snapshot)
            } catch {
                // Storage/decoder diagnostics can contain paths or private identifiers.
                return .unavailable
            }
        }
    }

    struct Row {
        let owner: String
        let admission: String
        let json: String
        let admittedAt: Int64
        let expiresAt: Int64
        let ticket: Int64
    }

    struct Wire: Codable {
        enum State: String, Codable {
            case unknown, queued, running, completed, failed, cancelled, timedOut
        }

        let kind: String
        let agentID: String
        let sessionKey: String
        let generation: String
        let runID: String?
        let label: String
        let state: State
        let factAtMS: Int64?
        let observedAtMS: Int64

        init(snapshot: OpenClawWidgetSnapshot, now: Date) throws {
            let selection = Selection(subject: snapshot.subject)
            _ = try selection.keys()
            self.kind = selection.run == nil ? "conversation" : "run"
            self.agentID = selection.session.agentID
            self.sessionKey = selection.session.sessionKey
            self.generation = selection.generation
            self.runID = selection.run?.runID
            self.label = snapshot.label
            self.observedAtMS = try OpenClawWidgetCache.milliseconds(snapshot.queryObservedAt)
            guard snapshot.queryObservedAt <= now else {
                throw Failure.invalidSnapshot
            }
            let fact = snapshot.sourceRecordedAt.flatMap { date -> Int64? in
                guard date <= now else { return nil }
                return try? OpenClawWidgetCache.milliseconds(date)
            }
            self.factAtMS = fact
            switch snapshot.subject {
            case .session(_, _, .unknown), .run(_, _, nil): self.state = .unknown
            case .session(_, _, .queued): self.state = .queued
            case .session(_, _, .running): self.state = .running
            case let .session(_, _, .terminal(outcome)), let .run(_, _, outcome?):
                self.state = switch outcome {
                case .completed: .completed
                case .failed: .failed
                case .cancelled: .cancelled
                case .timedOut: .timedOut
                }
            }
        }

        func encoded() throws -> String {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            let data = try encoder.encode(self)
            guard data.count <= OpenClawWidgetCache.maximumBytes else { throw Failure.capacity }
            guard let json = String(data: data, encoding: .utf8) else { throw Failure.invalidSnapshot }
            return json
        }

        static func decode(_ json: String) throws -> Self {
            let data = Data(json.utf8)
            guard data.count <= OpenClawWidgetCache.maximumBytes,
                  let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(fields.keys).isSubset(of: [
                      "kind", "agentID", "sessionKey", "generation", "runID", "label", "state", "factAtMS",
                      "observedAtMS",
                  ]),
                  fields.values.allSatisfy({ !($0 is NSNull) })
            else { throw Failure.invalidSnapshot }
            let wire = try JSONDecoder().decode(Self.self, from: data)
            guard wire.label.count <= 96, wire.label.utf8.count <= 384 else { throw Failure.invalidSnapshot }
            return wire
        }

        func snapshot(selection: Selection, nowMS: Int64) throws -> OpenClawWidgetSnapshot {
            guard self.agentID.utf8.elementsEqual(selection.session.agentID.utf8),
                  self.sessionKey.utf8.elementsEqual(selection.session.sessionKey.utf8),
                  self.generation.utf8.elementsEqual(selection.generation.utf8),
                  self.observedAtMS >= 0, self.observedAtMS <= nowMS,
                  self.factAtMS.map({ $0 >= 0 && $0 <= nowMS && nowMS - $0 < OpenClawWidgetCache.lifetimeMS }) ?? true
            else { throw Failure.invalidSnapshot }
            let outcome: OpenClawWidgetSnapshot.TerminalOutcome? = switch self.state {
            case .completed: .completed
            case .failed: .failed
            case .cancelled: .cancelled
            case .timedOut: .timedOut
            default: nil
            }
            let subject: OpenClawWidgetSnapshot.Subject
            if let run = selection.run {
                guard self.kind == "run", self.runID?.utf8.elementsEqual(run.runID.utf8) == true,
                      self.state == .unknown || outcome != nil
                else { throw Failure.invalidSnapshot }
                subject = .run(run, sessionID: selection.generation, outcome: outcome)
            } else {
                guard self.kind == "conversation", self.runID == nil else { throw Failure.invalidSnapshot }
                let state: OpenClawWidgetSnapshot.SessionState = if let outcome {
                    .terminal(outcome)
                } else {
                    switch self.state {
                    case .queued: .queued
                    case .running: .running
                    default: .unknown
                    }
                }
                subject = .session(selection.session, sessionID: selection.generation, state: state)
            }
            return OpenClawWidgetSnapshot(
                subject: subject,
                label: self.label,
                sourceRecordedAt: self.factAtMS.map { Date(timeIntervalSince1970: Double($0) / 1000) },
                queryObservedAt: Date(timeIntervalSince1970: Double(self.observedAtMS) / 1000))
        }
    }

    static func milliseconds(_ date: Date) throws -> Int64 {
        let value = date.timeIntervalSince1970 * 1000
        guard value.isFinite, value >= 0, value <= 9_007_199_254_740_991 - Double(self.lifetimeMS) else {
            throw Failure.invalidSnapshot
        }
        return Int64(value)
    }

    static func validateHeader(_ database: OpenClawSQLiteConnection) throws {
        let header = try database.readMainFileHeader()
        guard header.prefix(16).elementsEqual("SQLite format 3\u{0}".utf8),
              header[18] == 1, header[19] == 1, header[16] == 0x10, header[17] == 0,
              header[60..<64].reduce(Int64(0), { ($0 << 8) | Int64($1) }) == 1,
              header[68..<72].reduce(Int64(0), { ($0 << 8) | Int64($1) }) == self.applicationID
        else { throw Failure.incompatible }
    }

    static func validate(_ database: OpenClawSQLiteConnection) throws {
        guard try database.scalarInt64("PRAGMA application_id") == self.applicationID,
              try database.scalarInt64("PRAGMA user_version") == 1,
              try database.scalarInt64("PRAGMA page_size") == 4096,
              try database.scalarInt64("PRAGMA page_count") <= 256,
              try database.scalarText("PRAGMA journal_mode") == "delete",
              try database.scalarInt64("SELECT COUNT(*) FROM widget_meta WHERE singleton_id = 1") == 1
        else { throw Failure.incompatible }
        let totals = try database.prepare("""
        SELECT COUNT(*), COALESCE(SUM(length(CAST(payload_json AS BLOB)) +
          length(CAST(selection_key AS BLOB)) + length(CAST(owner_key AS BLOB)) +
          length(CAST(admission_id AS BLOB))), 0),
          COALESCE(SUM(payload_bytes != length(CAST(payload_json AS BLOB)) +
            length(CAST(selection_key AS BLOB)) + length(CAST(owner_key AS BLOB)) +
            length(CAST(admission_id AS BLOB))), 0)
        FROM widget_snapshots
        """)
        guard try totals.step() == .row,
              totals.int64(at: 0) <= self.maximumRows, totals.int64(at: 1) <= self.maximumBytes,
              totals.int64(at: 2) == 0
        else { throw Failure.capacity }
    }

    static func row(_ database: OpenClawSQLiteConnection, key: String) throws -> Row? {
        let statement = try database.prepare("""
        SELECT owner_key, admission_id, payload_json, admitted_at_ms, expires_at_ms, latest_ticket,
          length(CAST(payload_json AS BLOB))
        FROM widget_snapshots WHERE selection_key = ?
          AND length(CAST(payload_json AS BLOB)) <= 131072
        """)
        try statement.bindText(key, at: 1)
        guard try statement.step() == .row else { return nil }
        let json = try statement.requiredText(at: 2, field: "payload")
        // Cache JSON escapes NUL. Reject truncation without changing canonical
        // native-state text semantics or accepting a valid prefix of corrupt data.
        guard json.utf8.count == statement.int64(at: 6) else { throw Failure.invalidSnapshot }
        let admittedAt = statement.int64(at: 3)
        let expiresAt = statement.int64(at: 4)
        // Validate ordering before subtraction so corrupt deadlines cannot overflow or renew admission.
        guard admittedAt >= 0, expiresAt > admittedAt, expiresAt - admittedAt <= self.lifetimeMS else {
            throw Failure.invalidSnapshot
        }
        return try Row(
            owner: statement.requiredText(at: 0, field: "owner"),
            admission: statement.requiredText(at: 1, field: "admission"),
            json: json,
            admittedAt: admittedAt,
            expiresAt: expiresAt,
            ticket: statement.int64(at: 5))
    }
}
