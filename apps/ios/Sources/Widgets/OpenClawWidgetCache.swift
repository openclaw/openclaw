import CryptoKit
import Foundation
import OpenClawNativeActions
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
            // Arrays delimit exact UTF-8 identifiers, including canonical Gateway IDs.
            // These digests select rows; they confer no connection authority.
            return try (
                Self.digest(identifiers + [self.run == nil ? "conversation" : "run"]),
                Self.ownerKey(self.session.owner))
        }

        static func ownerKey(_ owner: OpenClawNativeOwnerRef) throws -> String {
            guard !owner.gatewayID.isEmpty, owner.gatewayID.utf8.count <= 4096,
                  !owner.profileID.isEmpty, owner.profileID.utf8.count <= 512
            else { throw Failure.invalidSelection }
            // Captured canonical owners only. URL-shaped fallback IDs must not
            // persist userinfo/query/fragment; opaque IDs retain their exact bytes.
            if let colon = owner.gatewayID.firstIndex(of: ":"),
               ["ws", "wss", "http", "https"].contains(owner.gatewayID[..<colon].lowercased())
            {
                guard let url = URLComponents(string: owner.gatewayID, encodingInvalidCharacters: false),
                      url.url != nil, let host = url.host, !host.isEmpty,
                      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil
                else { throw Failure.invalidSelection }
            }
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
                return try self.withDatabase { database in
                    guard let row = try OpenClawWidgetCache.row(database, key: keys.selection),
                          row.owner == keys.owner, time >= row.admittedAt, time < row.expiresAt
                    else { return .unavailable }
                    return try .snapshot(row.wire.snapshot(nowMS: time))
                }
            } catch {
                // Storage/decoder diagnostics can contain paths or private identifiers.
                return .unavailable
            }
        }

        fileprivate func snapshots(now: Date) throws -> [OpenClawWidgetSnapshot] {
            do {
                let time = try OpenClawWidgetCache.milliseconds(now)
                return try self.withDatabase { database in
                    let keys = try database.prepare("""
                    SELECT selection_key FROM widget_snapshots
                    WHERE admitted_at_ms <= ? AND expires_at_ms > ? ORDER BY selection_key LIMIT 64
                    """)
                    try keys.bindInt64(time, at: 1)
                    try keys.bindInt64(time, at: 2)
                    var snapshots: [OpenClawWidgetSnapshot] = []
                    while try keys.step() == .row {
                        let key = try keys.requiredText(at: 0, field: "selection")
                        guard let row = try OpenClawWidgetCache.row(database, key: key) else {
                            throw Failure.invalidSnapshot
                        }
                        try snapshots.append(row.wire.snapshot(nowMS: time))
                    }
                    return snapshots
                }
            } catch {
                throw Failure.unavailable
            }
        }

        private func withDatabase<T>(_ body: (OpenClawSQLiteConnection) throws -> T) throws -> T {
            try OpenClawWidgetContainer.validateDatabasePath(self.databaseURL)
            let database = try OpenClawSQLiteConnection(databaseURL: self.databaseURL, access: .readOnly)
            try OpenClawWidgetCache.validateHeader(database)
            // Pin quota validation and all rows to one read snapshot during app writes.
            try database.execute("BEGIN")
            defer { try? database.execute("ROLLBACK") }
            try OpenClawWidgetCache.validate(database)
            return try body(database)
        }
    }

    /// Cached eligibility only, never authentication or an action host.
    @MainActor
    struct Catalog: OpenClawNativeActionCatalog {
        let reader: Reader
        private let now: () -> Date

        init(reader: Reader, now: @escaping () -> Date = Date.init) {
            self.reader = reader
            self.now = now
        }

        func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
            try self.choices(matching: query).compactMap { snapshot in
                guard case let .session(session, _, _) = snapshot.subject else { return nil }
                return OpenClawNativeSessionChoice(
                    session: session, title: snapshot.label, gatewayName: session.owner.gatewayID)
            }
        }

        func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
            try self.choices(matching: query).compactMap { snapshot in
                guard case let .run(run, _, _) = snapshot.subject else { return nil }
                return run
            }
        }

        private func choices(matching query: String?) throws -> [OpenClawWidgetSnapshot] {
            let snapshots = try self.reader.snapshots(now: self.now())
            var generations: [OpenClawNativeSessionRef: Set<Data>] = [:]
            for snapshot in snapshots {
                let selection = Selection(subject: snapshot.subject)
                generations[selection.session, default: []].insert(Data(selection.generation.utf8))
            }
            let search = query.map { String($0.prefix(200)) } ?? ""
            return snapshots.filter { snapshot in
                let selection = Selection(subject: snapshot.subject)
                // A entity IDs omit generation. Never pick a generation by ordering
                // or search text; saved-ID lookup and action binding remain app-owned.
                guard generations[selection.session]?.count == 1 else { return false }
                return search.isEmpty || [
                    snapshot.label, selection.session.owner.gatewayID, selection.session.owner.profileID,
                    selection.session.agentID, selection.session.sessionKey, selection.run?.runID ?? "",
                ].contains { $0.localizedCaseInsensitiveContains(search) }
            }
        }
    }

    struct Row {
        let owner: String
        let admission: String
        let wire: Wire
        let admittedAt: Int64
        let expiresAt: Int64
        let ticket: Int64
    }

    struct Wire: Codable {
        enum State: String, Codable {
            case unknown, queued, running, completed, failed, cancelled, timedOut
        }

        let kind: String
        let gatewayID: String
        let profileID: String
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
            self.gatewayID = selection.session.owner.gatewayID
            self.profileID = selection.session.owner.profileID
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
                      "kind", "gatewayID", "profileID", "agentID", "sessionKey", "generation", "runID", "label",
                      "state", "factAtMS", "observedAtMS",
                  ]),
                  fields.values.allSatisfy({ !($0 is NSNull) })
            else { throw Failure.invalidSnapshot }
            let wire = try JSONDecoder().decode(Self.self, from: data)
            guard wire.label.count <= 96, wire.label.utf8.count <= 384 else { throw Failure.invalidSnapshot }
            return wire
        }

        func snapshot(nowMS: Int64) throws -> OpenClawWidgetSnapshot {
            guard self.observedAtMS >= 0, self.observedAtMS <= nowMS,
                  self.factAtMS.map({ $0 >= 0 && $0 <= nowMS && nowMS - $0 < OpenClawWidgetCache.lifetimeMS }) ?? true
            else { throw Failure.invalidSnapshot }
            return try OpenClawWidgetSnapshot(
                subject: self.subject(),
                label: self.label,
                sourceRecordedAt: self.factAtMS.map { Date(timeIntervalSince1970: Double($0) / 1000) },
                queryObservedAt: Date(timeIntervalSince1970: Double(self.observedAtMS) / 1000))
        }

        func subject() throws -> OpenClawWidgetSnapshot.Subject {
            let session = OpenClawNativeSessionRef(
                owner: .init(gatewayID: self.gatewayID, profileID: self.profileID),
                agentID: self.agentID,
                sessionKey: self.sessionKey)
            let outcome: OpenClawWidgetSnapshot.TerminalOutcome? = switch self.state {
            case .completed: .completed
            case .failed: .failed
            case .cancelled: .cancelled
            case .timedOut: .timedOut
            default: nil
            }
            if self.kind == "run" {
                guard let runID = self.runID, self.state == .unknown || outcome != nil
                else { throw Failure.invalidSnapshot }
                return .run(.init(session: session, runID: runID), sessionID: self.generation, outcome: outcome)
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
                return .session(session, sessionID: self.generation, state: state)
            }
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
        let wire = try Wire.decode(json)
        let keys = try Selection(subject: wire.subject()).keys()
        let owner = try statement.requiredText(at: 0, field: "owner")
        guard keys.selection == key, keys.owner == owner else { throw Failure.invalidSelection }
        let admittedAt = statement.int64(at: 3)
        let expiresAt = statement.int64(at: 4)
        // Validate ordering before subtraction so corrupt deadlines cannot overflow or renew admission.
        guard admittedAt >= 0, expiresAt > admittedAt, expiresAt - admittedAt <= self.lifetimeMS else {
            throw Failure.invalidSnapshot
        }
        return try Row(
            owner: owner,
            admission: statement.requiredText(at: 1, field: "admission"),
            wire: wire,
            admittedAt: admittedAt,
            expiresAt: expiresAt,
            ticket: statement.int64(at: 5))
    }
}
