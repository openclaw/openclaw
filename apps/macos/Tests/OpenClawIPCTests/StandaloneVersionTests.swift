import CryptoKit
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct StandaloneVersionTests {
    @Test(arguments: ["cli", "service", "probe"], ["valid", "invalid", "missing"])
    func `standalone version lookup uses validated metadata without executing`(
        caller: String,
        metadata: String) async throws
    {
        let invalidManifest = metadata != "valid"
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("openclaw")
        let marker = root.appendingPathComponent("executed")
        let script = "#!/bin/sh\necho executed > '\(marker.path)'\necho 9999.1.0\n"
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let library = root.appendingPathComponent("runtime/lib/libsqlite3.dylib")
        try FileManager.default.createDirectory(
            at: library.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Data().write(to: library)
        let ownership = Data(#"{"schemaVersion":1,"owner":"macos-app"}"#.utf8)
        try ownership.write(to: root.appendingPathComponent("runtime/openclaw-install-owner.json"))
        let bytes = Data(script.utf8)
        let manifest: [String: Any] = [
            "schemaVersion": invalidManifest ? 2 : 1,
            "mode": "jit",
            "buildId": "fixture",
            "openclaw": ["version": "2026.8.1", "commit": String(repeating: "a", count: 40)],
            "executable": [
                "path": "openclaw",
                "sizeBytes": bytes.count,
                "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
            ],
            "runtime": ["path": "runtime", "sizeBytes": ownership.count],
        ]
        if metadata != "missing" {
            try JSONSerialization.data(withJSONObject: manifest).write(to: root.appendingPathComponent("manifest.json"))
        }

        if caller == "probe" {
            let version = await ExecutableVersionProbe.read(
                binary: executable.path, pathEnv: "", logger: Logger(
                    subsystem: "ai.openclaw.tests",
                    category: "version"), label: "standalone test")
            #expect(version == (invalidManifest ? nil : "2026.8.1"))
        } else {
            let result = if caller == "service" {
                await CLIInstaller.managedStatus(
                    expectedVersion: "2026.8.1",
                    installedCLI: .init(prefix: [executable.path], sqliteLibrary: nil),
                    usesBundledRuntime: false)
            } else {
                await CLIInstaller.status(location: executable.path)
            }
            #expect(result == (invalidManifest
                    ? .unusable(location: executable.path)
                    : .ready(location: executable.path, version: "2026.8.1")))
        }
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }
}
