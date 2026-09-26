import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import XCTest
@testable import OpenClaw

private final class AccessRestartBundleMarker: NSObject {}

@MainActor
private enum AccessRestartProof {
    private struct RequirementFailure: Error {}

    struct FileIdentity: Codable, Equatable {
        let path: String
        let device: UInt64
        let inode: UInt64

        init(_ url: URL) throws {
            self.path = url.resolvingSymlinksInPath().path
            let attributes = try FileManager.default.attributesOfItem(atPath: self.path)
            self.device = try XCTUnwrap(attributes[.systemNumber] as? NSNumber).uint64Value
            self.inode = try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber).uint64Value
        }
    }

    struct Installation: Codable, Equatable {
        let bundleID: String
        let testBundleID: String
        let app: FileIdentity
        let testBundle: FileIdentity
        let executable: FileIdentity
        let testExecutable: FileIdentity
        let container: FileIdentity
        let executableSHA256: String
        let testExecutableSHA256: String

        init() throws {
            let tests = Bundle(for: AccessRestartBundleMarker.self)
            let executable = try XCTUnwrap(Bundle.main.executableURL)
            let testExecutable = try XCTUnwrap(tests.executableURL)
            self.bundleID = try XCTUnwrap(Bundle.main.bundleIdentifier)
            self.testBundleID = try XCTUnwrap(tests.bundleIdentifier)
            self.app = try FileIdentity(Bundle.main.bundleURL)
            self.testBundle = try FileIdentity(tests.bundleURL)
            self.executable = try FileIdentity(executable)
            self.testExecutable = try FileIdentity(testExecutable)
            self.container = try FileIdentity(URL(fileURLWithPath: NSHomeDirectory()))
            self.executableSHA256 = try AccessRestartProof.digest(executable)
            self.testExecutableSHA256 = try AccessRestartProof.digest(testExecutable)
        }
    }

    struct Receipt: Codable {
        var phase: String
        let nonce: String
        let source: String
        let simulator: String
        let seedPID: Int32
        var verifyPID: Int32?
        var seedProcessExited: Bool
        let installation: Installation
        let expiresAt: Date
    }

    /// XCTest assertions normally continue. A failed invariant must stop before receipt writes or cleanup.
    static func require(
        _ condition: Bool,
        _ message: String = "Restart invariant failed",
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        guard condition else {
            XCTFail(message, file: file, line: line)
            throw RequirementFailure()
        }
    }

    static func environment(_ key: String) throws -> String {
        try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_ACCESS_RESTART_" + key])
    }

    static func nonce() throws -> String {
        let value = try self.environment("NONCE")
        try AccessRestartProof.require(UUID(uuidString: value) != nil)
        return value
    }

    static func origin(control: Bool = false) throws -> CloudflareAccessOrigin {
        let prefix = control ? "control" : "signed-out"
        return try CloudflareAccessOrigin(XCTUnwrap(URL(string: "https://\(prefix)-\(self.nonce()).example.test")))
    }

    static func stableID() throws -> String {
        try "manual|\(XCTUnwrap(self.origin().url.host))|443"
    }

    static func receiptURL() throws -> URL {
        let directory = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first)
        return try directory.appendingPathComponent("access-restart-\(self.nonce()).plist")
    }

    nonisolated static func digest(_ executable: URL) throws -> String {
        try SHA256.hash(data: Data(contentsOf: executable)).map { String(format: "%02x", $0) }.joined()
    }

    static func seedProcessExists(_ pid: Int32) throws -> Bool {
        if Darwin.kill(pid, 0) == 0 {
            return true
        }
        let error = errno
        try AccessRestartProof.require(error == ESRCH, "Could not determine whether the seed process exited")
        return false
    }

    static func session(control: Bool, expires: Date) throws -> CloudflareAccessSession {
        let issuer = try XCTUnwrap(URL(string: "https://example.cloudflareaccess.com"))
        let application = try CloudflareAccessApplication(
            origin: self.origin(control: control),
            issuer: issuer,
            audience: "restart-test")
        let subject = control ? "untouched-control" : "acknowledged-sign-out"
        let token = try CloudflareAccessTestTokens().token([
            "iss": issuer.absoluteString, "aud": [application.audience],
            "type": "app", "sub": subject, "exp": expires.timeIntervalSince1970,
        ])
        return CloudflareAccessSession(application: application, subject: subject, token: token, expiresAt: expires)
    }

    static func checkPairingAndProfile() throws {
        let id = try self.stableID()
        let entry = try XCTUnwrap(GatewaySettingsStore.loadGatewayRegistry().entries.first { $0.stableID == id })
        try AccessRestartProof.require(entry.accessOrigin == self.origin())
        try AccessRestartProof.require(entry.useTLS && entry.port == 443 && entry.name == "Access restart fixture")
        try AccessRestartProof.require(entry.lastConnectedAtMs == 1_700_000_000_123)
        let credentials = try GatewaySettingsStore.loadGatewayCredentials(instanceId: self.nonce(), gatewayStableID: id)
        try AccessRestartProof.require(credentials.token == "restart-pairing-token")
        try AccessRestartProof.require(credentials.password == "restart-pairing-password")
        try AccessRestartProof.require(credentials.bootstrapToken == nil && credentials.suppressStoredDeviceAuth)
        try AccessRestartProof.require(GatewaySettingsStore
            .loadGatewayCustomHeaders(gatewayStableID: id) == ["X-Existing-Ingress": "preserved"])
    }

    static func cleanup() throws {
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        try AccessRestartProof.require(persistence.delete(self.origin()))
        try AccessRestartProof.require(persistence.delete(self.origin(control: true)))
        let id = try self.stableID()
        _ = GatewaySettingsStore.saveGatewayCustomHeaders([:], gatewayStableID: id)
        try GatewaySettingsStore.deleteGatewayCredentials(instanceId: self.nonce(), stableID: id)
        _ = GatewaySettingsStore.removeGatewayRegistryEntry(stableID: id)
    }
}

@MainActor
final class GatewayAccessRestartTests: XCTestCase {
    func testAcknowledgedSignOutSurvivesProcessRestart() async throws {
        try XCTSkipIf(ProcessInfo.processInfo.environment["OPENCLAW_ACCESS_RESTART_NONCE"] == nil)
        let simulator = try XCTUnwrap(ProcessInfo.processInfo.environment["SIMULATOR_UDID"])
        try AccessRestartProof.require(simulator == AccessRestartProof.environment("DEVICE"))
        let url = try AccessRestartProof.receiptURL()
        // Fixed repetitions relaunch the host. A final receipt is terminal, never another seed.
        if FileManager.default.fileExists(atPath: url.path) {
            try await self.verify(url: url, simulator: simulator)
        } else {
            try await self.seed(url: url, simulator: simulator)
        }
    }

    private func seed(url: URL, simulator: String) async throws {
        let nonce = try AccessRestartProof.nonce()
        let origin = try AccessRestartProof.origin()
        let control = try AccessRestartProof.origin(control: true)
        let stableID = try AccessRestartProof.stableID()
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        try AccessRestartProof.require(persistence.load(origin) == nil && persistence.load(control) == nil)
        try AccessRestartProof.require(!FileManager.default.fileExists(atPath: AccessRestartProof.receiptURL().path))
        try AccessRestartProof.require(
            !GatewaySettingsStore.loadGatewayRegistry().entries.contains { $0.stableID == stableID })
        let expires = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970) + 3600)
        for isControl in [false, true] {
            let session = try AccessRestartProof.session(control: isControl, expires: expires)
            let store = CloudflareAccessSessionStore(authenticate: { _, _ in session }, retireTransports: { _ in })
            let application = CloudflareAccessApplication(
                origin: session.origin,
                issuer: session.issuer,
                audience: session.audience)
            _ = try await store.signIn(application: application, openBrowser: { _ in }).value
            try AccessRestartProof.require(persistence.load(session.origin) != nil)
        }
        let entry = GatewaySettingsStore.GatewayRegistryEntry(
            stableID: stableID,
            kind: .manual,
            name: "Access restart fixture",
            host: origin.url.host,
            port: 443,
            useTLS: true,
            accessOrigin: origin,
            lastConnectedAtMs: 1_700_000_000_123)
        try AccessRestartProof.require(GatewaySettingsStore.upsertGatewayRegistryEntry(entry))
        try AccessRestartProof.require(GatewaySettingsStore.saveGatewayCredentials(
            token: "restart-pairing-token",
            bootstrapToken: nil,
            password: "restart-pairing-password",
            gatewayStableID: stableID,
            suppressStoredDeviceAuth: true,
            instanceId: nonce))
        try AccessRestartProof.require(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Existing-Ingress": "preserved"],
            gatewayStableID: stableID))
        let owner = GatewayIngressController(retireTransports: { _ in })
        try AccessRestartProof.require(owner.hasSession(stableID: stableID))
        await owner.signOut(stableID: stableID)
        try AccessRestartProof.require(owner.attention?.message.hasPrefix("Cloudflare Access is signed out") == true)
        try AccessRestartProof.require(!owner.hasSession(stableID: stableID) && persistence.load(origin) == nil)
        try AccessRestartProof.require(persistence.load(control) != nil)
        try AccessRestartProof.checkPairingAndProfile()
        let receipt = try AccessRestartProof.Receipt(
            phase: "seeded",
            nonce: nonce,
            source: AccessRestartProof.environment("SOURCE"),
            simulator: simulator,
            seedPID: ProcessInfo.processInfo.processIdentifier,
            verifyPID: nil,
            seedProcessExited: false,
            installation: AccessRestartProof.Installation(),
            expiresAt: expires)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListEncoder().encode(receipt).write(to: url, options: .atomic)
        // Deliberately retain only this nonce's fixture until the separate process verifies it.
        // No state override or cleanup may turn process restart into object reconstruction.
        print(
            "ACCESS_RESTART seed pid=\(receipt.seedPID) source=\(receipt.source) " +
                "sha256=\(receipt.installation.executableSHA256)")
    }

    private func verify(url: URL, simulator: String) async throws {
        // Read before any fixture writes: reseeding or cleanup must not manufacture persistence proof.
        var receipt = try PropertyListDecoder().decode(AccessRestartProof.Receipt.self, from: Data(contentsOf: url))
        try AccessRestartProof.require(
            receipt.phase == "seeded" && receipt.verifyPID == nil && !receipt.seedProcessExited)
        try AccessRestartProof.require(receipt.nonce == AccessRestartProof.nonce())
        try AccessRestartProof.require(
            receipt.source == AccessRestartProof.environment("SOURCE") && receipt.simulator == simulator)
        let pid = ProcessInfo.processInfo.processIdentifier
        try AccessRestartProof.require(receipt.seedPID > 1 && receipt.seedPID != pid)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while try AccessRestartProof.seedProcessExists(receipt.seedPID), clock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        try AccessRestartProof.require(!AccessRestartProof.seedProcessExists(receipt.seedPID))
        try AccessRestartProof.require(receipt.installation == AccessRestartProof.Installation())
        let persistence = CloudflareAccessSessionStore.Persistence.keychain
        let origin = try AccessRestartProof.origin()
        try AccessRestartProof.require(persistence.load(origin) == nil)
        let store = CloudflareAccessSessionStore(retireTransports: { _ in })
        try AccessRestartProof.require(store.snapshot(for: origin) == nil)
        let control = try XCTUnwrap(store.snapshot(for: AccessRestartProof.origin(control: true)))
        try AccessRestartProof.require(
            control.session.subject == "untouched-control" && control.session.expiresAt == receipt.expiresAt)
        try AccessRestartProof.checkPairingAndProfile()
        receipt.phase = "verified"
        receipt.verifyPID = pid
        receipt.seedProcessExited = true
        try PropertyListEncoder().encode(receipt).write(to: url, options: .atomic)
        try AccessRestartProof.cleanup()
        // Keep the final receipt for host verification and reject an unexpected third repetition.
        print("ACCESS_RESTART verify pid=\(pid) prior=\(receipt.seedPID) source=\(receipt.source)")
    }
}
