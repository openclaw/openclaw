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

            let stored = try #require(OpenClawSQLiteKVStore.readJSONData(
                scope: "identity.device",
                key: "default"))
            let object = try #require(try JSONSerialization.jsonObject(with: stored) as? [String: Any])
            #expect(object["version"] as? Int == 1)
            #expect(object["deviceId"] as? String == identity.deviceId)
            #expect((object["publicKeyPem"] as? String)?.contains("BEGIN PUBLIC KEY") == true)
            #expect((object["privateKeyPem"] as? String)?.contains("BEGIN PRIVATE KEY") == true)
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
                    label: "PRIVATE KEY",
                    body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
            try OpenClawSQLiteKVStore.writeJSONData(
                scope: "identity.device",
                key: "default",
                data: stored)

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

    @Test("requires doctor migration when legacy identity exists before SQLite row")
    func requiresDoctorMigrationForLegacyIdentity() throws {
        try Self.withTempStateDir { stateDir in
            let legacyURL = Self.legacyIdentityURL(stateDir: stateDir)
            try FileManager.default.createDirectory(
                at: legacyURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try "{}".write(to: legacyURL, atomically: true, encoding: .utf8)

            #expect(DeviceIdentityStore.legacyIdentityMigrationRequired())
            #expect(!FileManager.default.fileExists(atPath: Self.databaseURL(stateDir: stateDir).path))
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

            let stored = try #require(OpenClawSQLiteKVStore.readJSONData(
                scope: "identity.device-auth",
                key: "default"))
            let object = try #require(try JSONSerialization.jsonObject(with: stored) as? [String: Any])
            #expect(object["deviceId"] as? String == "device-1")
            let tokens = try #require(object["tokens"] as? [String: Any])
            #expect(tokens["gateway"] != nil)

            DeviceAuthStore.clearToken(deviceId: "device-1", role: "gateway")
            #expect(DeviceAuthStore.loadToken(deviceId: "device-1", role: "gateway") == nil)
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

    private static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
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
}
