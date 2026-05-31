import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test("persists generated device identity in SQLite without JSON sidecars")
    func persistsGeneratedIdentityInSQLite() throws {
        try Self.withTempStateDir { stateDir in
            let identity = DeviceIdentityStore.loadOrCreate()
            let loaded = DeviceIdentityStore.loadOrCreate()

            #expect(loaded.deviceId == identity.deviceId)
            #expect(loaded.publicKey == identity.publicKey)
            #expect(FileManager.default.fileExists(atPath: Self.databaseURL(stateDir: stateDir).path))
            #expect(!FileManager.default.fileExists(atPath: Self.legacyIdentityURL(stateDir: stateDir).path))

            let stored = try #require(OpenClawSQLiteStateStore.readDeviceIdentity())
            #expect(stored.deviceId == identity.deviceId)
            #expect(stored.publicKeyPem.contains("BEGIN PUBLIC KEY"))
            #expect(stored.privateKeyPem.contains(Self.privateKeyMarker("BEGIN")))
        }
    }

    @Test("surfaces SQLite identity read failures distinctly from missing rows")
    func surfacesSQLiteIdentityReadFailures() throws {
        try Self.withTempStateDir { stateDir in
            try FileManager.default.createDirectory(
                at: Self.databaseURL(stateDir: stateDir),
                withIntermediateDirectories: true)

            #expect(throws: Error.self) {
                _ = try OpenClawSQLiteStateStore.readDeviceIdentityChecked()
            }
        }
    }

    @Test("loads TypeScript PEM identity schema from SQLite")
    func loadsTypeScriptPEMIdentitySchema() throws {
        try Self.withTempStateDir { stateDir in
            let stored = try Self.identityJSON(
                publicKeyPem: Self.pem(
                    label: "PUBLIC KEY",
                    body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
                privateKeyPem: Self.pem(
                    label: "PRIVATE" + " KEY",
                    body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
            let object = try #require(try JSONSerialization.jsonObject(with: stored) as? [String: Any])
            try OpenClawSQLiteStateStore.writeDeviceIdentity(
                identity: OpenClawSQLiteDeviceIdentityRow(
                    deviceId: try #require(object["deviceId"] as? String),
                    publicKeyPem: try #require(object["publicKeyPem"] as? String),
                    privateKeyPem: try #require(object["privateKeyPem"] as? String),
                    createdAtMs: try #require(object["createdAtMs"] as? Int)))

            let identity = DeviceIdentityStore.loadOrCreate()

            #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
            #expect(identity.publicKey == "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
            #expect(identity.privateKey == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
            #expect(DeviceIdentityStore.publicKeyBase64Url(identity) == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
            #expect(!FileManager.default.fileExists(atPath: Self.legacyIdentityURL(stateDir: stateDir).path))

            let signature = try #require(DeviceIdentityStore.signPayload("hello", identity: identity))
            let publicKeyData = try #require(Data(base64Encoded: identity.publicKey))
            let signatureData = try #require(Self.base64UrlDecode(signature))
            let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
            #expect(publicKey.isValidSignature(signatureData, for: Data("hello".utf8)))
        }
    }

    @Test("migrates legacy raw device identity sidecar into SQLite")
    func migratesLegacyRawIdentitySidecarIntoSQLite() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyIdentityURL(stateDir: stateDir)
            try FileManager.default.createDirectory(
                at: legacyURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let legacy = Self.legacyRawIdentity()
            let data = try JSONEncoder().encode(legacy)
            try data.write(to: legacyURL)

            #expect(DeviceIdentityStore.legacyIdentityMigrationRequired())
            let identity = DeviceIdentityStore.loadOrCreate()

            #expect(identity.deviceId == legacy.deviceId)
            #expect(identity.publicKey == legacy.publicKey)
            #expect(identity.privateKey == legacy.privateKey)
            #expect(identity.createdAtMs == legacy.createdAtMs)
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path))

            let stored = try #require(OpenClawSQLiteStateStore.readDeviceIdentity())
            #expect(stored.deviceId == legacy.deviceId)
            #expect(FileManager.default.fileExists(atPath: Self.databaseURL(stateDir: stateDir).path))
        }
    }

    @Test("keeps default legacy device state under app support OpenClaw dir")
    func keepsDefaultLegacyDeviceStateUnderAppSupportOpenClawDir() throws {
        try Self.withDefaultStateEnvironment {
            let appSupport = try #require(
                FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
            let expected = appSupport
                .appendingPathComponent("OpenClaw", isDirectory: true)
                .standardizedFileURL

            #expect(DeviceIdentityPaths.legacyStateDirURL().standardizedFileURL == expected)
        }
    }

    @Test("stores device auth tokens in SQLite without JSON sidecars")
    func storesDeviceAuthTokensInSQLite() throws {
        try Self.withTempStateDir { stateDir in
            let entry = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: " gateway ",
                token: "token-1",
                scopes: ["write", " read ", "write"])

            #expect(entry.role == "gateway")
            #expect(entry.scopes == ["read", "write"])
            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway")?.token == "token-1")
            #expect(!FileManager.default.fileExists(atPath: Self.legacyAuthURL(stateDir: stateDir).path))

            let stored = try #require(OpenClawSQLiteStateStore.readDeviceAuthToken(
                deviceId: "device-1",
                role: "gateway"))
            #expect(stored.token == "token-1")
            #expect(stored.scopesJSON.contains("read"))

            DeviceAuthStore.clearToken(deviceId: "device-1", role: "gateway")
            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway") == nil)
        }
    }

    @Test("migrates legacy device auth sidecar into SQLite")
    func migratesLegacyDeviceAuthSidecarIntoSQLite() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                token: "token-1",
                scopes: ["write", " read ", "write"])

            let entry = try #require(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway"))

            #expect(entry.token == "token-1")
            #expect(entry.role == "gateway")
            #expect(entry.scopes == ["read", "write"])
            #expect(entry.updatedAtMs == 1_700_000_000_000)
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
            let stored = try #require(OpenClawSQLiteStateStore.readDeviceAuthToken(
                deviceId: "device-1",
                role: "gateway"))
            #expect(stored.token == "token-1")
        }
    }

    @Test("ignores Android SecurePrefs token markers in shared SQLite auth rows")
    func ignoresAndroidSecurePrefsTokenMarkers() throws {
        try Self.withTempStateDir { _ in
            try OpenClawSQLiteStateStore.upsertDeviceAuthToken(
                OpenClawSQLiteDeviceAuthTokenRow(
                    deviceId: "device-1",
                    role: "gateway",
                    token: "__openclaw_secure_prefs__",
                    scopesJSON: "[]",
                    updatedAtMs: 1))

            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway") == nil)
        }
    }

    @Test("migrates same-device legacy auth roles before the first SQLite save")
    func migratesSameDeviceLegacyAuthRolesBeforeFirstSQLiteSave() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                tokens: [
                    "gateway": ("gateway-token", ["read"]),
                    "operator": ("old-operator-token", ["operator.read"]),
                ])

            _ = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: "operator",
                token: "operator-token",
                scopes: ["operator.write"])

            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway")?.token == "gateway-token")
            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "operator")?.token == "operator-token")
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        }
    }

    @Test("does not resurrect legacy device auth role after SQLite rows exist")
    func doesNotResurrectLegacyDeviceAuthRoleAfterSQLiteRowsExist() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            _ = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: "operator",
                token: "operator-token",
                scopes: ["operator"])

            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                role: "admin",
                token: "stale-admin-token",
                scopes: ["admin"])

            _ = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: "operator",
                token: "operator-token-2",
                scopes: ["operator"])

            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "admin") == nil)
            #expect(OpenClawSQLiteStateStore.readDeviceAuthToken(deviceId: "device-1", role: "admin") == nil)
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        }
    }

    @Test("keeps legacy device auth sidecar when SQLite import fails")
    func keepsLegacyDeviceAuthSidecarWhenSQLiteImportFails() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                token: "token-1",
                scopes: ["read"])
            try FileManager.default.createDirectory(
                at: Self.databaseURL(stateDir: stateDir),
                withIntermediateDirectories: true)

            let entry = try #require(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway"))
            #expect(entry.token == "token-1")
            #expect(entry.scopes == ["read"])
            #expect(FileManager.default.fileExists(atPath: legacyURL.path))
        }
    }

    @Test("falls back to legacy device auth sidecar when SQLite write fails")
    func fallsBackToLegacyDeviceAuthSidecarWhenSQLiteWriteFails() throws {
        try Self.withTempStateDir { stateDir in
            try FileManager.default.createDirectory(
                at: Self.databaseURL(stateDir: stateDir),
                withIntermediateDirectories: true)

            let entry = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: " gateway ",
                token: "token-fallback",
                scopes: ["write"])

            #expect(entry.token == "token-fallback")
            #expect(entry.role == "gateway")
            #expect(FileManager.default.fileExists(atPath: Self.legacyAuthURL(stateDir: stateDir).path))
            let loaded = try #require(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway"))
            #expect(loaded.token == "token-fallback")
            #expect(loaded.scopes == ["write"])
        }
    }

    @Test("merges legacy device auth sidecar when SQLite write fails")
    func mergesLegacyDeviceAuthSidecarWhenSQLiteWriteFails() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                token: "gateway-token",
                scopes: ["read"])
            try FileManager.default.createDirectory(
                at: Self.databaseURL(stateDir: stateDir),
                withIntermediateDirectories: true)

            _ = DeviceAuthStore.storeToken(
                deviceId: "device-1",
                role: "operator",
                token: "operator-token",
                scopes: ["write"])

            let data = try Data(contentsOf: legacyURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let tokens = try #require(root["tokens"] as? [String: Any])
            #expect((tokens["gateway"] as? [String: Any])?["token"] as? String == "gateway-token")
            #expect((tokens["operator"] as? [String: Any])?["token"] as? String == "operator-token")
        }
    }

    @Test("drops stale legacy device auth sidecar when storing a different device")
    func dropsStaleLegacyDeviceAuthSidecarWhenReplacingDevice() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyAuthURL(stateDir: stateDir)
            try Self.writeLegacyAuthSidecar(
                legacyURL,
                deviceId: "device-1",
                token: "stale-token",
                scopes: ["read"])

            let entry = DeviceAuthStore.storeToken(
                deviceId: "device-2",
                role: "gateway",
                token: "fresh-token",
                scopes: ["write"])

            #expect(entry.token == "fresh-token")
            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway") == nil)
            #expect(DeviceAuthStore.loadToken(deviceId: "device-2", role: "gateway")?.token == "fresh-token")
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        }
    }

    private static func withTempStateDir(_ body: (URL) throws -> Void) throws {
        let previous = DeviceIdentityPaths.testingStateDirURL
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        DeviceIdentityPaths.testingStateDirURL = tempDir
        defer {
            DeviceIdentityPaths.testingStateDirURL = previous
            try? FileManager.default.removeItem(at: tempDir)
        }
        try body(tempDir)
    }

    private static func withDefaultStateEnvironment(_ body: () throws -> Void) throws {
        let previousTestingStateDir = DeviceIdentityPaths.testingStateDirURL
        let previousStateDir = getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) }
        DeviceIdentityPaths.testingStateDirURL = nil
        unsetenv("OPENCLAW_STATE_DIR")
        defer {
            DeviceIdentityPaths.testingStateDirURL = previousTestingStateDir
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
        }
        try body()
    }

    private static func databaseURL(stateDir: URL) -> URL {
        stateDir
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite")
    }

    private static func legacyIdentityURL(stateDir: URL) -> URL {
        stateDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
    }

    private static func legacyAuthURL(stateDir: URL) -> URL {
        stateDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device-auth.json", isDirectory: false)
    }

    private static func writeLegacyAuthSidecar(
        _ legacyURL: URL,
        deviceId: String,
        role: String = "gateway",
        token: String,
        scopes: [String]) throws
    {
        try FileManager.default.createDirectory(
            at: legacyURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let legacy = [
            "version": 1,
            "deviceId": deviceId,
            "tokens": [
                role: [
                    "token": token,
                    "role": role,
                    "scopes": scopes,
                    "updatedAtMs": 1_700_000_000_000,
                ],
            ],
        ] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: legacy, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: legacyURL)
    }

    private static func writeLegacyAuthSidecar(
        _ legacyURL: URL,
        deviceId: String,
        tokens: [String: (token: String, scopes: [String])]) throws
    {
        try FileManager.default.createDirectory(
            at: legacyURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let tokenEntries = tokens.map { role, value in
            (
                role,
                [
                    "token": value.token,
                    "role": role,
                    "scopes": value.scopes,
                    "updatedAtMs": 1_700_000_000_000,
                ] as [String: Any]
            )
        }
        let tokenObject = Dictionary(uniqueKeysWithValues: tokenEntries)
        let legacy = [
            "version": 1,
            "deviceId": deviceId,
            "tokens": tokenObject,
        ] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: legacy, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: legacyURL)
    }

    private static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    private static func legacyRawIdentity() -> DeviceIdentity {
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKeyData = privateKey.publicKey.rawRepresentation
        let privateKeyData = privateKey.rawRepresentation
        let deviceId = SHA256.hash(data: publicKeyData).compactMap {
            String(format: "%02x", $0)
        }.joined()
        return DeviceIdentity(
            deviceId: deviceId,
            publicKey: publicKeyData.base64EncodedString(),
            privateKey: privateKeyData.base64EncodedString(),
            createdAtMs: 1_700_000_000_000)
    }

    private static func identityJSON(publicKeyPem: String, privateKeyPem: String) throws -> Data {
        let object: [String: Any] = [
            "version": 1,
            "deviceId": "stale-device-id",
            "publicKeyPem": publicKeyPem,
            "privateKeyPem": privateKeyPem,
            "createdAtMs": 1_700_000_000_000,
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
    }

    private static func pem(label: String, body: String) -> String {
        "-----BEGIN \(label)-----\n\(body)\n-----END \(label)-----\n"
    }

    private static func privateKeyMarker(_ boundary: String) -> String {
        "-----\(boundary) \("PRIVATE" + " KEY")-----"
    }
}
