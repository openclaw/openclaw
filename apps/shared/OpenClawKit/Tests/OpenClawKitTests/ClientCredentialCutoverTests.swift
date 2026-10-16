import Foundation
import OpenClawNativeState
import Testing
@testable import OpenClawKit

struct ClientCredentialCutoverTests {
    @Test func `inspection leaves missing credentials absent and refuses an unmigrated source`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        var operation = ClientCredentialOperation(kind: .identityRead)
        operation.identity_key = "primary"
        #expect(try DeviceCredentialAccess.executeOffline(root: root, operation: operation).identity == nil)
        #expect(!FileManager.default.fileExists(atPath: root.path))
        try self.createLegacy(root: root, material: DeviceIdentityStore.generateMaterial())
        let before = try snapshot(root)
        #expect(throws: OpenClawNativeStateError.self) {
            try DeviceCredentialAccess.executeOffline(root: root, operation: operation)
        }
        #expect(!FileManager.default.fileExists(
            atPath: OpenClawClientCredentialStore.databaseURL(rootURL: root).path))
        #expect(try self.snapshot(root) == before)
    }

    @Test func `app dispatch after close never creates an offline store`() throws {
        let root = self.root()
        DeviceCredentialAccess.close()
        var operation = ClientCredentialOperation(kind: .identityCreate)
        let material = DeviceIdentityStore.generateMaterial()
        operation.identity = .init(
            key: "primary",
            deviceID: material.identity.deviceId,
            publicKeyPEM: material.publicKeyPEM,
            privateKeyPEM: material.privateKeyPEM,
            createdAtMs: material.identity.createdAtMs,
            updatedAtMs: material.identity.createdAtMs)
        #expect(throws: OpenClawNativeStateError.self) {
            try DeviceCredentialAccess.executeForApp(root: root, operation: operation)
        }
        #expect(!FileManager.default.fileExists(atPath: root.path))
    }

    @Test func `malformed identity create wire request cannot persist a private identity`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let operation = try JSONDecoder().decode(ClientCredentialOperation.self, from: Data("""
        {"kind":"identity.create","identity":{"identity_key":"primary","device_id":"invalid",
         "public_key_pem":"invalid-public-key","private_key_pem":"invalid-private-key",
         "created_at_ms":1,"updated_at_ms":1}}
        """.utf8))
        #expect(throws: Error.self) { try DeviceCredentialAccess.execute(root: root, operation: operation) }
        let owner = try OpenClawClientCredentialStore(rootURL: root)
        defer { owner.close() }
        #expect(try owner.readIdentity(key: "primary") == nil)
    }

    @Test func `app ownership releases physical custody between operations`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = try AppClientCredentialCustody(roots: [root], independentRoots: [])
        defer { app.close() }
        try app.withOwner(root: root) { _ in }
        let offline = try OpenClawClientCredentialStore(rootURL: root)
        offline.close()
        #expect(app.owns(root: root))
        app.close()
        #expect(!app.owns(root: root))
    }

    @Test func `client bootstrap persists identity without opening shared state`() async throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        try await DeviceIdentityStore.withStateDirectory(root) {
            let first = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            let second = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            #expect(first == second)
            #expect(FileManager.default
                .fileExists(atPath: root.appendingPathComponent("client/credentials.sqlite").path))
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("state/openclaw.sqlite").path))
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: first.deviceId,
                role: "operator",
                token: "first",
                gatewayID: "gateway"))
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: first.deviceId,
                role: "operator",
                token: "second",
                gatewayID: "gateway",
                expectedToken: "first",
                onlyIfUnchanged: true))
            DeviceAuthStore.clearToken(
                deviceId: first.deviceId,
                role: "operator",
                gatewayID: "gateway",
                observedToken: "first")
            #expect(DeviceAuthStore.loadToken(deviceId: first.deviceId, role: "operator", gatewayID: "gateway")?
                .token == "second")
        }
    }

    @Test func `consumed legacy auth cannot resurrect a revoked token`() async throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = root.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(
            at: legacy.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(DeviceAuthStoreFile(version: 1, deviceId: "legacy-device", tokens: [
            "operator": DeviceAuthEntry(token: "old-token", role: "operator", scopes: [], updatedAtMs: 12),
        ]))
        try data.write(to: legacy)
        try await DeviceIdentityStore.withStateDirectory(root) {
            _ = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            #expect(DeviceAuthStore.loadToken(deviceId: "legacy-device", role: "operator")?.token == "old-token")
            DeviceAuthStore.clearToken(deviceId: "legacy-device", role: "operator")
            try data.write(to: legacy)
            #expect(DeviceAuthStore.loadToken(deviceId: "legacy-device", role: "operator") == nil)
        }
    }

    @Test func `identity-only native source imports retained auth JSON once`() async throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        try self.createLegacy(root: root, material: material, includeAuthTable: false)
        let legacy = try self.writeLegacyAuth(root: root, material: material)
        let before = try snapshot(root)
        try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { owner in
            let receipt = try owner.readReceipt()?.receipt
            #expect(receipt?.legacyImports["auth:primary"] == nil)
        }
        try await DeviceIdentityStore.withStateDirectory(root) {
            #expect(try DeviceIdentityStore.loadOrCreatePersistedOrThrow() == material.identity)
            #expect(DeviceAuthStore.loadToken(deviceId: material.identity.deviceId, role: "operator")?
                .token == "json-token")
            DeviceAuthStore.clearToken(deviceId: material.identity.deviceId, role: "operator")
            try legacy.data.write(to: legacy.url)
            _ = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            #expect(DeviceAuthStore.loadToken(deviceId: material.identity.deviceId, role: "operator") == nil)
        }
        #expect(try self.snapshot(root) == before)
        #expect(try Data(contentsOf: legacy.url) == legacy.data)
    }

    @Test func `empty native auth table keeps retained JSON revoked`() async throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        try self.createLegacy(root: root, material: material)
        do {
            let source = try OpenClawNativeStateSQLite(databaseURL: root
                .appendingPathComponent("state/openclaw.sqlite"))
            try source.execute("DELETE FROM device_auth_tokens")
        }
        let legacy = try self.writeLegacyAuth(root: root, material: material)
        try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { owner in
            let receipt = try owner.readReceipt()?.receipt
            #expect(receipt?.legacyImports["auth:primary"] != nil)
        }
        try await DeviceIdentityStore.withStateDirectory(root) {
            let identity = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            #expect(identity == material.identity)
            #expect(DeviceAuthStore.loadToken(deviceId: material.identity.deviceId, role: "operator") == nil)
        }
        #expect(try Data(contentsOf: legacy.url) == legacy.data)
    }

    @Test func `first native auth table invalidates copied JSON tokens without resetting claims`() async throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        try self.createLegacy(root: root, material: material, includeAuthTable: false)
        _ = try self.writeLegacyAuth(root: root, material: material)
        try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { _ in }
        try await DeviceIdentityStore.withStateDirectory(root) {
            _ = try DeviceIdentityStore.loadOrCreatePersistedOrThrow()
            #expect(DeviceAuthStore.loadToken(deviceId: material.identity.deviceId, role: "operator")?
                .token == "json-token")
            let claim = String(repeating: "a", count: 64)
            let beforeHash = try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { owner in
                var receipt = try #require(owner.readReceipt()?.receipt)
                var imported = try #require(receipt.legacyImports["auth:primary"])
                imported.sha256 = claim
                receipt.legacyImports["auth:primary"] = imported
                try owner.writeReceipt(receipt)
                return receipt.source?.sha256
            }
            do {
                let source = try OpenClawNativeStateSQLite(databaseURL: root
                    .appendingPathComponent("state/openclaw.sqlite"))
                try self.createAuthTable(source)
            }
            #expect(throws: OpenClawNativeStateError.self) {
                try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true, inspection: true) { _ in }
            }
            #expect(try DeviceIdentityStore.loadOrCreatePersistedOrThrow() == material.identity)
            #expect(DeviceAuthStore.loadToken(deviceId: material.identity.deviceId, role: "operator") == nil)
            try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { owner in
                let receipt = try #require(owner.readReceipt()?.receipt)
                #expect(receipt.source?.sha256 != beforeHash)
                #expect(receipt.legacyImports["auth:primary"]?.sha256 == claim)
            }
        }
    }

    @Test func `native auth table presence matches TypeScript snapshot hash vectors`() throws {
        for authTablePresent in [false, true] {
            let root = self.root()
            defer { try? FileManager.default.removeItem(at: root) }
            try self.createLegacy(
                root: root,
                material: DeviceIdentityStore.generateMaterial(),
                includeAuthTable: authTablePresent)
            do {
                let source = try OpenClawNativeStateSQLite(databaseURL: root
                    .appendingPathComponent("state/openclaw.sqlite"))
                try source.execute("DELETE FROM device_identities")
                if authTablePresent { try source.execute("DELETE FROM device_auth_tokens") }
            }
            try DeviceCredentialAccess.withPreparedOwner(root: root, independent: true) { owner in
                let expected = authTablePresent
                    ? "00823eca1c9659c886cfb6649d1a4ae0ec202a43451409bf755426ae8056c725"
                    : "7d7ade847f734ab42b59b04464a5f1bf5e89e582a7cdd8f2f39b12274e16d038"
                let receipt = try owner.readReceipt()?.receipt
                #expect(receipt?.source?.sha256 == expected)
            }
        }
    }

    @Test func `native source is unchanged and repeated startup preserves refreshed and revoked tokens`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        try self.createLegacy(root: root, material: material)
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        let before = try snapshot(root)
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        #expect(try self.snapshot(root) == before)
        #expect(try owner.readIdentity(key: "primary")?.privateKeyPEM == material.privateKeyPEM)
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node")?.token == "retained-token")
        var refresh = ClientCredentialOperation(kind: .tokenReplace)
        refresh.key = .init(deviceID: material.identity.deviceId, role: "node")
        refresh.token = .init(
            deviceID: material.identity.deviceId,
            role: "node",
            token: "refreshed-token",
            scopesJSON: "[\"fresh\"]",
            updatedAtMs: 21)
        _ = try owner.execute(refresh)
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node")?.token == "refreshed-token")
        var remove = ClientCredentialOperation(kind: .tokenRemove)
        remove.key = .init(deviceID: material.identity.deviceId, role: "node")
        #expect(try owner.execute(remove).changed == true)
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node") == nil)
        #expect(try self.snapshot(root) == before)
    }

    @Test func `same inode source changes rebuild the copy but retain immutable JSON claims`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let material = DeviceIdentityStore.generateMaterial()
        try self.createLegacy(root: root, material: material)
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        _ = try owner.importLegacy(key: "auth:shareExtension", sha256: nil)
        var socket = ClientCredentialOperation(kind: .socketEnsure)
        socket.fallback = .init(path: "/synthetic.sock", token: "local-socket-token", updatedAtMs: 23)
        _ = try owner.execute(socket)
        let sourceURL = root.appendingPathComponent("state/openclaw.sqlite")
        let binding = try ClientCredentialReceipt.SharedFile.inspect(sourceURL)
        do {
            let source = try OpenClawNativeStateSQLite(databaseURL: sourceURL, createIfMissing: false)
            try source.execute("UPDATE device_auth_tokens SET token='restored-token', scopes_json='[\"a/b\",\"é\"]'")
        }
        #expect(try ClientCredentialReceipt.SharedFile.inspect(sourceURL) == binding)
        let before = try snapshot(root)
        #expect(throws: OpenClawNativeStateError.self) {
            try NativeClientCredentialMigration.prepare(
                root: root, owner: owner, allowIndependentSource: true, inspection: true)
        }
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node")?.token == "retained-token")
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node")?.token == "restored-token")
        #expect(try owner.readReceipt()?.receipt.legacyImports["auth:shareExtension"] != nil)
        #expect(try owner.readSocketCredentials()?.token == "local-socket-token")
        #expect(try self.snapshot(root) == before)
        let replacement = root.appendingPathComponent("restored-source.sqlite")
        try FileManager.default.copyItem(at: sourceURL, to: replacement)
        _ = try FileManager.default.replaceItemAt(sourceURL, withItemAt: replacement)
        #expect(try ClientCredentialReceipt.SharedFile.inspect(sourceURL) != binding)
        try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        #expect(try owner.readToken(deviceID: material.identity.deviceId, role: "node")?.token == "restored-token")
        #expect(try owner.readReceipt()?.receipt.legacyImports["auth:shareExtension"] != nil)
        #expect(try owner.readSocketCredentials()?.token == "local-socket-token")
        try FileManager.default.moveItem(at: sourceURL, to: root.appendingPathComponent("saved-source.sqlite"))
        #expect(throws: OpenClawNativeStateError.self) {
            try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        }
        #expect(try owner.readIdentity(key: "primary")?.deviceID == material.identity.deviceId)
    }

    @Test func `WAL source refusal creates no sidecar and preserves source modes and bytes`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        try self.createLegacy(root: root, material: DeviceIdentityStore.generateMaterial())
        let source = try OpenClawNativeStateSQLite(databaseURL: root.appendingPathComponent("state/openclaw.sqlite"))
        try source.execute("PRAGMA journal_mode=WAL; UPDATE device_auth_tokens SET token='wal-token'")
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        let before = try snapshot(root)
        #expect(throws: OpenClawNativeStateError.self) {
            try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        }
        #expect(try self.snapshot(root) == before)
        #expect(try owner.readReceipt() == nil)
    }

    @Test func `canonical receipt admits a version zero PG anchor without opening it as native`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        let sourceURL = root.appendingPathComponent("state/openclaw.sqlite")
        do {
            let source = try OpenClawNativeStateSQLite(databaseURL: sourceURL)
            try source
                .execute(
                    "CREATE TABLE openclaw_engine_anchor (engine TEXT); " +
                        "INSERT INTO openclaw_engine_anchor VALUES ('postgres')")
        }
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        try owner.writeReceipt(ClientCredentialReceipt(sharedFile: .inspect(sourceURL)))
        owner.close()
        let before = try snapshot(root)
        try DeviceCredentialAccess.withPreparedOwner(root: root, independent: false) { _ in }
        #expect(try self.snapshot(root) == before)
    }

    @Test func `unknown native source is preserved`() throws {
        let root = self.root()
        defer { try? FileManager.default.removeItem(at: root) }
        do {
            let source = try OpenClawNativeStateSQLite(databaseURL: root
                .appendingPathComponent("state/openclaw.sqlite"))
            try source.execute("CREATE TABLE unrelated (value TEXT)")
        }
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        let before = try snapshot(root)
        #expect(throws: Error.self) {
            try NativeClientCredentialMigration.prepare(root: root, owner: owner, allowIndependentSource: true)
        }
        #expect(try self.snapshot(root) == before)
    }

    private struct SourceFile: Equatable { let data: Data
        let mode: Int
    }

    private func snapshot(_ root: URL) throws -> [String: SourceFile] {
        let directory = root.appendingPathComponent("state")
        return try Dictionary(uniqueKeysWithValues: FileManager.default.contentsOfDirectory(atPath: directory.path)
            .map { name in
                let file = directory.appendingPathComponent(name)
                let mode = try #require(FileManager.default
                    .attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
                return try (name, SourceFile(data: Data(contentsOf: file), mode: mode.intValue))
            })
    }

    private func root() -> URL {
        URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory())
            .appendingPathComponent("client-cutover-\(UUID().uuidString)")
    }

    private func createLegacy(
        root: URL,
        material: DeviceIdentityMaterial,
        includeAuthTable: Bool = true) throws
    {
        let source = try OpenClawNativeStateSQLite(databaseURL: root.appendingPathComponent("state/openclaw.sqlite"))
        try source.execute("""
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY, device_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device ON device_identities(device_id, updated_at_ms DESC);
        """)
        let row = try source.prepare("INSERT INTO device_identities VALUES ('primary',?,?,?,?,?)")
        try row.bindText(material.identity.deviceId, at: 1)
        try row.bindText(material.publicKeyPEM, at: 2)
        try row.bindText(material.privateKeyPEM, at: 3)
        try row.bindInt64(material.identity.createdAtMs, at: 4)
        try row.bindInt64(17, at: 5)
        _ = try row.step()
        guard includeAuthTable else { return }
        try self.createAuthTable(source)
        let token = try source.prepare("INSERT INTO device_auth_tokens VALUES (?, 'node', 'retained-token', '[]', 19)")
        try token.bindText(material.identity.deviceId, at: 1)
        _ = try token.step()
    }

    private func createAuthTable(_ source: OpenClawNativeStateSQLite) throws {
        try source.execute("""
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (device_id, role)
        ) STRICT;
        CREATE INDEX idx_device_auth_tokens_updated ON device_auth_tokens(updated_at_ms DESC, device_id, role);
        """)
    }

    private func writeLegacyAuth(root: URL, material: DeviceIdentityMaterial) throws -> (url: URL, data: Data) {
        let url = root.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(DeviceAuthStoreFile(
            version: 1,
            deviceId: material.identity.deviceId,
            tokens: ["operator": DeviceAuthEntry(token: "json-token", role: "operator", scopes: [], updatedAtMs: 12)]))
        try data.write(to: url)
        return (url, data)
    }
}
