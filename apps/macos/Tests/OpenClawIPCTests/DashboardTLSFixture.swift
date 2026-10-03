import Foundation
import Security
import Testing
@testable import OpenClaw

/// Synthetic listener identity; Security keeps the import in memory, never Keychain.
struct DashboardTLSFixture {
    let identity: sec_identity_t
    let certificate: Data

    @MainActor
    init() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func openssl(_ arguments: [String]) async throws {
            let result = try await BoundedProcess.run(
                path: "/usr/bin/openssl",
                arguments: arguments,
                workingDirectory: directory.path,
                timeout: 60)
            try #require(
                result.terminationStatus == 0,
                Comment(rawValue: String(decoding: result.output, as: UTF8.self)))
        }
        try await openssl([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
            "-subj", "/CN=localhost", "-keyout", "key.pem", "-out", "cert.pem",
        ])
        try await openssl([
            "pkcs12", "-export", "-inkey", "key.pem", "-in", "cert.pem", "-out", "identity.p12",
            "-passout", "pass:fixture", "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES",
            "-macalg", "sha1",
        ])
        let data = try Data(contentsOf: directory.appendingPathComponent("identity.p12"))
        var items: CFArray?
        let options: [String: Any] = [
            kSecImportExportPassphrase as String: "fixture",
            kSecImportToMemoryOnly as String: true,
        ]
        try #require(SecPKCS12Import(data as CFData, options as CFDictionary, &items) == errSecSuccess)
        let imported = try #require((items as? [[String: Any]])?.first?[kSecImportItemIdentity as String])
        // SecPKCS12Import guarantees a SecIdentity at kSecImportItemIdentity.
        // swiftlint:disable:next force_cast
        let identity = imported as! SecIdentity
        self.identity = try #require(sec_identity_create(identity))
        var certificate: SecCertificate?
        try #require(SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess)
        self.certificate = try SecCertificateCopyData(#require(certificate)) as Data
    }
}
