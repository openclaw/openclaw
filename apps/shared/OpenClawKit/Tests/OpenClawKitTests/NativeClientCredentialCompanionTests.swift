import Foundation
import OpenClawNativeState
import Testing
@testable import OpenClawKit

struct NativeClientCredentialCompanionTests {
    @Test(arguments: [false, true])
    func `app custody imports credentials beside PortGuardian without changing the source`(
        companion: Bool) throws
    {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        let sourceURL = root.appendingPathComponent("state/openclaw.sqlite")
        try self.seed(sourceURL, material: material, companion: companion)
        let before = try Data(contentsOf: sourceURL)
        let mode = try FileManager.default.attributesOfItem(atPath: sourceURL.path)[.posixPermissions] as? NSNumber
        let entries = try FileManager.default.contentsOfDirectory(atPath: sourceURL.deletingLastPathComponent().path)
            .sorted()
        let custody = try AppClientCredentialCustody(roots: [root], independentRoots: [root])
        defer { custody.close() }
        try custody.withOwner(root: root, inspection: true) { owner throws in
            #expect(try owner.readIdentity(key: "primary")?.privateKeyPEM == material.privateKeyPEM)
            #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "operator")?.token == "retained")
            #expect(try owner.readReceipt()?.receipt.source?.kind == "independent")
        }
        #expect(try Data(contentsOf: sourceURL) == before)
        #expect(try FileManager.default
            .attributesOfItem(atPath: sourceURL.path)[.posixPermissions] as? NSNumber == mode)
        #expect(try FileManager.default.contentsOfDirectory(atPath: sourceURL.deletingLastPathComponent().path)
            .sorted() == entries)
    }

    @Test(arguments: ["unknown-table", "malformed-guardian"])
    func `app custody refuses unknown or malformed companions without importing credentials`(
        corruption: String) throws
    {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let sourceURL = root.appendingPathComponent("state/openclaw.sqlite")
        try self.seed(sourceURL, material: DeviceIdentityStore.generateMaterial(), companion: true)
        do {
            let source = try OpenClawNativeStateSQLite(databaseURL: sourceURL)
            if corruption == "unknown-table" {
                try source.execute("CREATE TABLE unrelated (value TEXT)")
            } else {
                try source.execute("DROP INDEX idx_macos_port_guardian_records_port")
            }
        }
        let before = try Data(contentsOf: sourceURL)
        #expect(throws: OpenClawNativeStateError.self) {
            _ = try AppClientCredentialCustody(roots: [root], independentRoots: [root])
        }
        #expect(try Data(contentsOf: sourceURL) == before)
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        #expect(try owner.readIdentity(key: "primary") == nil)
        #expect(try owner.readReceipt() == nil)
    }

    private func seed(_ url: URL, material: DeviceIdentityMaterial, companion: Bool) throws {
        let source = try OpenClawNativeStateSQLite(databaseURL: url)
        try source.execute("""
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY, device_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device ON device_identities(device_id, updated_at_ms DESC);
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (device_id, role)
        ) STRICT;
        CREATE INDEX idx_device_auth_tokens_updated ON device_auth_tokens(updated_at_ms DESC, device_id, role);
        """)
        let identity = try source.prepare("INSERT INTO device_identities VALUES ('primary',?,?,?,?,?)")
        try identity.bindText(material.identity.deviceId, at: 1)
        try identity.bindText(material.publicKeyPEM, at: 2)
        try identity.bindText(material.privateKeyPEM, at: 3)
        try identity.bindInt64(material.identity.createdAtMs, at: 4)
        try identity.bindInt64(material.identity.createdAtMs, at: 5)
        _ = try identity.step()
        let token = try source.prepare("INSERT INTO device_auth_tokens VALUES (?, 'operator', 'retained', '[]', 19)")
        try token.bindText(material.identity.deviceId, at: 1)
        _ = try token.step()
        if companion {
            // Frozen shipped native-v0 companion, independent of the current schema owner.
            try source.execute("""
            CREATE TABLE macos_port_guardian_records (
              pid INTEGER NOT NULL PRIMARY KEY, port INTEGER NOT NULL, command TEXT NOT NULL,
              mode TEXT NOT NULL, timestamp REAL NOT NULL
            ) STRICT;
            CREATE INDEX idx_macos_port_guardian_records_port
              ON macos_port_guardian_records(port, timestamp DESC);
            """)
            try source
                .execute("INSERT INTO macos_port_guardian_records VALUES (4242,18789,'synthetic-ssh','remote',42.5)")
        }
    }
}
