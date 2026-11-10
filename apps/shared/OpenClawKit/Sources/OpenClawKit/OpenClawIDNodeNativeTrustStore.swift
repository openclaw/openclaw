import Foundation
import OpenClawNativeState

/// Restart inputs, NOT dialing authority. Refresh Discovery and verify membership against current
/// high-water state before dialing. Stored evidence never constructs an OpenClawIDNodeTrustTarget.
public struct OpenClawIDNodeSavedEnrollment: Sendable {
    public let enrollmentID: UUID
    public let discoveryOrigin: URL
    public let relayURL: URL
    public let serverKey: String
    public let peerKey: String
    public let evidence: Data
}

/// Durable adapter using the native SQLite owner. A per-attempt adapter captures its app lifecycle
/// guard; multiple adapters still merge/check the CURRENT row in one SQLite transaction.
public actor OpenClawIDNodeNativeTrustStore: OpenClawIDNodeTrustStore {
    private let databaseURL: URL
    private let enrollmentID: UUID
    private let assertCurrent: @Sendable () throws -> Void
    private var connection: OpenClawNativeStateSQLite?
    private var closed = false

    /// The guard must throw when the app replaces/revokes this enrollment attempt. W is never passed
    /// here: enrollmentID selects its separate device-only Keychain item, on iOS as well as macOS.
    public init(databaseURL: URL = URL.applicationSupportDirectory
                    .appendingPathComponent("OpenClaw/node-enrollment.sqlite"), enrollmentID: UUID,
                assertCurrent: @escaping @Sendable () throws -> Void) {
        self.databaseURL = databaseURL
        self.enrollmentID = enrollmentID
        self.assertCurrent = assertCurrent
    }

    public func close() {
        closed = true
        connection = nil
    }

    public func load(hostname: String) throws -> OpenClawIDNodeTrustState? {
        let database = try database()
        let state = try Self.load(hostname: hostname, database: database)
        try checkAuthority()
        return state
    }

    public func savedEnrollment(hostname: String) throws -> OpenClawIDNodeSavedEnrollment? {
        let database = try database()
        let query = try database.prepare("""
        SELECT enrollment_id, discovery_origin, relay_url, server_key, peer_key, evidence_json
        FROM openclaw_id_node_enrollments WHERE hostname = ? AND enrollment_id = ?
        """)
        try query.bindText(hostname, at: 1)
        try query.bindText(enrollmentID.uuidString, at: 2)
        guard try query.step() == .row else { return nil }
        guard let id = try UUID(uuidString: query.requiredText(at: 0, field: "enrollment ID")) else {
            throw OpenClawNativeStateError("Invalid saved node enrollment identity")
        }
        let record = try OpenClawIDNodeSavedEnrollment(enrollmentID: id,
            discoveryOrigin: OpenClawIDNodeEnrollmentLink.discoveryOrigin(query.requiredText(at: 1, field: "Discovery origin")),
            relayURL: OpenClawIDNodeEnrollmentLink.routingURL(query.requiredText(at: 2, field: "relay URL"), originOnly: false),
            serverKey: query.requiredText(at: 3, field: "server key"),
            peerKey: query.requiredText(at: 4, field: "peer key"),
            evidence: Data(query.requiredText(at: 5, field: "evidence").utf8))
        try checkAuthority()
        return record
    }

    public func observe(hostname: String, state: OpenClawIDNodeTrustState) throws {
        let database = try database()
        try database.withImmediateTransaction {
            try checkAuthority()
            let merged = try OpenClawIDNodeTrust.mergeObservation(state,
                with: Self.load(hostname: hostname, database: database))
            try Self.write(hostname: hostname, state: merged, database: database)
            try checkAuthority()
        }
    }

    public func commit(_ target: OpenClawIDNodeTrustTarget) throws {
        let database = try database()
        try database.withImmediateTransaction {
            try checkAuthority()
            let current = try Self.load(hostname: target.hostname, database: database)
            try OpenClawIDNodeTrust.validateCommit(target.state, replacing: current)
            let merged = try OpenClawIDNodeTrust.mergeObservation(target.state, with: current)
            try Self.write(hostname: target.hostname, state: merged, database: database)
            let query = try database.prepare("""
            INSERT INTO openclaw_id_node_enrollments
              (enrollment_id, discovery_origin, relay_url, server_key, peer_key, evidence_json, hostname)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (hostname, enrollment_id) DO UPDATE SET discovery_origin = excluded.discovery_origin,
              relay_url = excluded.relay_url, server_key = excluded.server_key,
              peer_key = excluded.peer_key, evidence_json = excluded.evidence_json
            """)
            for (offset, value) in [enrollmentID.uuidString, target.discoveryOrigin.absoluteString,
                                    target.relayURL.absoluteString, target.serverKey, target.peerKey,
                                    String(decoding: target.evidence, as: UTF8.self), target.hostname].enumerated() {
                try query.bindText(value, at: Int32(offset + 1))
            }
            _ = try query.step()
            // No await inside the transaction. Failed storage or revoked attempt rolls it all back.
            try checkAuthority()
        }
    }

    private func checkAuthority() throws {
        try Task.checkCancellation()
        guard !closed else { throw OpenClawNativeStateError("Node enrollment store is closed") }
        try assertCurrent()
    }

    private func database() throws -> OpenClawNativeStateSQLite {
        try checkAuthority()
        if let connection { return connection }
        let database = try OpenClawIDNodeStateSchema.open(databaseURL: databaseURL)
        try checkAuthority()
        connection = database
        return database
    }

    private static func load(hostname: String, database: OpenClawNativeStateSQLite) throws -> OpenClawIDNodeTrustState? {
        let query = try database.prepare("""
        SELECT claw_id, root_fingerprint, binding_sequence, snapshot_sequence, snapshot_issued_at,
          snapshot_binding_sequence FROM openclaw_id_node_targets WHERE hostname = ?
        """)
        try query.bindText(hostname, at: 1)
        guard try query.step() == .row else { return nil }
        return try .init(clawID: query.requiredText(at: 0, field: "Claw ID"),
            rootFingerprint: query.requiredText(at: 1, field: "root fingerprint"),
            bindingSequence: query.int64(at: 2), snapshotSequence: query.int64(at: 3),
            snapshotIssuedAt: query.int64(at: 4), snapshotBindingSequence: query.int64(at: 5))
    }

    private static func write(hostname: String, state: OpenClawIDNodeTrustState,
                              database: OpenClawNativeStateSQLite) throws {
        // Keep saved restart inputs on refused refreshes; they grant no authority to dial.
        let query = try database.prepare("""
        INSERT INTO openclaw_id_node_targets
          (hostname, claw_id, root_fingerprint, binding_sequence, snapshot_sequence, snapshot_issued_at,
           snapshot_binding_sequence) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(hostname) DO UPDATE SET binding_sequence = excluded.binding_sequence,
          snapshot_sequence = excluded.snapshot_sequence, snapshot_issued_at = excluded.snapshot_issued_at,
          snapshot_binding_sequence = excluded.snapshot_binding_sequence
        """)
        try query.bindText(hostname, at: 1)
        try query.bindText(state.clawID, at: 2)
        try query.bindText(state.rootFingerprint, at: 3)
        try query.bindInt64(state.bindingSequence, at: 4)
        try query.bindInt64(state.snapshotSequence, at: 5)
        try query.bindInt64(state.snapshotIssuedAt, at: 6)
        try query.bindInt64(state.snapshotBindingSequence, at: 7)
        _ = try query.step()
    }
}
