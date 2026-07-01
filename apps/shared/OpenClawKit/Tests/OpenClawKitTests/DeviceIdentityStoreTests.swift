import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test
    func `state directory override wins over shared app group storage`() {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let overrideURL = tempDir.appendingPathComponent("override", isDirectory: true)
        let legacyURL = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let sharedURL = tempDir.appendingPathComponent("shared", isDirectory: true)

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: overrideURL,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            temporaryDirectory: tempDir)

        #expect(selected == overrideURL)
        #expect(!FileManager.default.fileExists(atPath: sharedURL.path))
    }

    @Test
    func `shared app group storage wins over legacy app support storage`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let legacyURL = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let sharedURL = tempDir.appendingPathComponent("shared", isDirectory: true)
        let legacyIdentityURL = legacyURL.appendingPathComponent("identity", isDirectory: true)
        let legacyDeviceURL = legacyIdentityURL.appendingPathComponent("device.json", isDirectory: false)
        let sharedIdentityURL = sharedURL.appendingPathComponent("identity", isDirectory: true)
        let sharedDeviceURL = sharedIdentityURL.appendingPathComponent("device.json", isDirectory: false)
        try FileManager.default.createDirectory(at: legacyIdentityURL, withIntermediateDirectories: true)
        try "legacy-device\n".write(to: legacyDeviceURL, atomically: true, encoding: .utf8)

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: nil,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            temporaryDirectory: tempDir)

        #expect(selected == sharedURL)
        #expect(!FileManager.default.fileExists(atPath: sharedDeviceURL.path))
    }

    @Test
    func `share extension profile uses separate identity and auth files`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        let shareIdentity = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "primary-token")
        _ = DeviceAuthStore.storeToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            token: "share-token",
            profile: .shareExtension)

        let identityDir = tempDir.appendingPathComponent("identity", isDirectory: true)
        #expect(primaryIdentity.deviceId != shareIdentity.deviceId)
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("device.json").path))
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("share-device.json").path))
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("device-auth.json").path))
        #expect(FileManager.default
            .fileExists(atPath: identityDir.appendingPathComponent("share-device-auth.json").path))
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?.token == "primary-token")
        #expect(
            DeviceAuthStore
                .loadToken(deviceId: shareIdentity.deviceId, role: "node", profile: .shareExtension)?.token ==
                "share-token")

        DeviceAuthStore.clearAll(profile: .shareExtension)

        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?.token == "primary-token")
        #expect(DeviceAuthStore
            .loadToken(deviceId: shareIdentity.deviceId, role: "node", profile: .shareExtension) == nil)
    }

    @Test
    func `loads TypeScript PEM identity schema without rewriting or regenerating`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        #expect(identity.publicKey == "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
        #expect(identity.privateKey == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        #expect(DeviceIdentityStore.publicKeyBase64Url(identity) == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
        let signature = try #require(DeviceIdentityStore.signPayload("hello", identity: identity))
        let publicKeyData = try #require(Data(base64Encoded: identity.publicKey))
        let signatureData = try #require(Self.base64UrlDecode(signature))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        #expect(publicKey.isValidSignature(signatureData, for: Data("hello".utf8)))
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    @Test
    func `does not overwrite a recognized invalid TypeScript identity schema`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = """
        {
          "version": 1,
          "deviceId": "stale-device-id",
          "publicKeyPem": "not-a-valid-public-key",
          "privateKeyPem": "not-a-valid-private-key",
          "createdAtMs": 1700000000000
        }
        """
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId != "stale-device-id")
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    private static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    private static func identityJSON(publicKeyPem: String, privateKeyPem: String) throws -> String {
        let object: [String: Any] = [
            "version": 1,
            "deviceId": "stale-device-id",
            "publicKeyPem": publicKeyPem,
            "privateKeyPem": privateKeyPem,
            "createdAtMs": 1_700_000_000_000,
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    private static func pem(label: String, body: String) -> String {
        "-----BEGIN \(label)-----\n\(body)\n-----END \(label)-----\n"
    }
}
