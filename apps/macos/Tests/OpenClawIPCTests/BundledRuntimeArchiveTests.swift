import CryptoKit
import Foundation
import Testing
@testable import OpenClaw

extension BundledRuntimeTests {
    private func makeArchive(at app: URL, buildID: String, nativeAlias: Bool = false) async throws -> URL {
        let dist = try self.makeBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: buildID, command: "unused")
        let resources = app.appendingPathComponent("Contents/Resources")
        let payload = app.deletingLastPathComponent().appendingPathComponent("payload-\(buildID)")
        let package = payload.appendingPathComponent("lib/node_modules/openclaw")
        try FileManager.default.createDirectory(
            at: package.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: dist.deletingLastPathComponent(), to: package)
        try "# Runtime documentation\n".write(
            to: package.appendingPathComponent("README.md"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.createSymbolicLink(
            atPath: package.appendingPathComponent("package-link").path, withDestinationPath: "README.md")
        if nativeAlias {
            let nativeBin = resources.appendingPathComponent("runtime/bin")
            try FileManager.default.moveItem(
                at: nativeBin.appendingPathComponent("bun"),
                to: nativeBin.appendingPathComponent("bun-real"))
            let payloadBin = payload.appendingPathComponent("bin")
            try FileManager.default.createDirectory(at: payloadBin, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                atPath: payloadBin.appendingPathComponent("bun").path, withDestinationPath: "bun-real")
        }
        let archive = resources.appendingPathComponent("runtime.aar")
        let result = await ShellExecutor.runDetailed(
            command: [
                "/usr/bin/aa", "archive", "-d", payload.path, "-o", archive.path,
                "-a", "raw", "-t", "8", "-exclude-field", "uid,gid",
            ],
            cwd: nil,
            env: [:],
            timeout: 5)
        try #require(result.success, "Archive fixture failed: \(result.stderr)")
        try self.updateArchiveMetadata(app: app) { info in
            info["OpenClawRuntimeArchiveFormatVersion"] = 1
            info["OpenClawRuntimeArchiveSHA256"] = try SHA256.hash(data: Data(contentsOf: archive))
                .map { String(format: "%02x", $0) }.joined()
        }
        return archive
    }

    private func updateArchiveMetadata(app: URL, change: (inout [String: Any]) throws -> Void) throws {
        let plist = app.appendingPathComponent("Contents/Info.plist")
        var info = try #require(PropertyListSerialization.propertyList(
            from: Data(contentsOf: plist), format: nil) as? [String: Any])
        try change(&info)
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: plist)
    }

    @Test(arguments: [
        "missing-format",
        "invalid-format",
        "missing-digest",
        "invalid-digest",
        "mismatched-digest",
        "missing-archive",
        "corrupt",
        "invalid-archive",
    ])
    func `archive failures preserve the selected loose runtime and publish no partial build`(
        failure: String) async throws
    {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: [:])
        let oldApp = home.appendingPathComponent("Loose.app")
        _ = try self.makeBundle(at: oldApp, builtAt: "old", buildID: "loose-build", command: "unused")
        let old = try await BundledRuntime.seed(
            bundle: #require(Bundle(url: oldApp)),
            profile: profile,
            homeDirectory: home)
        let app = home.appendingPathComponent("Archived.app")
        let archive = try await self.makeArchive(at: app, buildID: "archive-build")
        switch failure {
        case "missing-format": try self
            .updateArchiveMetadata(app: app) { $0.removeValue(forKey: "OpenClawRuntimeArchiveFormatVersion") }
        case "invalid-format": try self
            .updateArchiveMetadata(app: app) { $0["OpenClawRuntimeArchiveFormatVersion"] = 2 }
        case "missing-digest": try self
            .updateArchiveMetadata(app: app) { $0.removeValue(forKey: "OpenClawRuntimeArchiveSHA256") }
        case "invalid-digest": try self
            .updateArchiveMetadata(app: app) { $0["OpenClawRuntimeArchiveSHA256"] = "invalid" }
        case "mismatched-digest": try self
            .updateArchiveMetadata(app: app) { $0["OpenClawRuntimeArchiveSHA256"] = String(repeating: "0", count: 64) }
        case "missing-archive": try FileManager.default.removeItem(at: archive)
        case "corrupt": try Data("corrupt".utf8).write(to: archive)
        default:
            let bytes = Data("not an AppleArchive".utf8)
            try bytes.write(to: archive)
            try self.updateArchiveMetadata(app: app) {
                $0["OpenClawRuntimeArchiveSHA256"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }
                    .joined()
            }
        }
        do {
            _ = try await BundledRuntime.seed(bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
            Issue.record("Invalid archive was accepted: \(failure)")
        } catch let error as BundledRuntime.SeedError {
            #expect(error.localizedDescription.contains("Reinstall OpenClaw.app."))
        }
        let current = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
        #expect(current.root.path == old.root.path)
        #expect(try FileManager.default.contentsOfDirectory(atPath: old.root.deletingLastPathComponent().path)
            .allSatisfy { !$0.contains(".partial-") && $0 != "archive-build" })
    }

    @Test func `archive upgrade is atomic preserves links and reuses only the same build`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: [:])
        let looseApp = home.appendingPathComponent("Loose.app")
        _ = try self.makeBundle(at: looseApp, builtAt: "old", buildID: "loose-build", command: "unused")
        let looseBundle = try #require(Bundle(url: looseApp))
        let loose = try await BundledRuntime.seed(bundle: looseBundle, profile: profile, homeDirectory: home)
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let cli = state.appendingPathComponent("bin/openclaw")
        let originalCLI = try Data(contentsOf: cli)
        for build in ["archive-1", "archive-2"] {
            let app = home.appendingPathComponent("\(build).app")
            let archive = try await self.makeArchive(at: app, buildID: build, nativeAlias: build == "archive-1")
            let bundle = try #require(Bundle(url: app))
            let prepared = try await BundledRuntime.prepare(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.path == loose.root.path)
            #expect(try Data(contentsOf: cli) == originalCLI)
            #expect(FileManager.default.isExecutableFile(atPath: prepared.bun.path))
            #expect(try String(contentsOf: prepared.packageRoot.appendingPathComponent("README.md"), encoding: .utf8)
                == "# Runtime documentation\n")
            #expect(try FileManager.default
                .destinationOfSymbolicLink(atPath: prepared.packageRoot.appendingPathComponent("package-link").path)
                == "README.md")
            // A published build is reused without reading or extracting its archive again.
            try Data("corrupted after extraction".utf8).write(to: archive)
            let reused = try await BundledRuntime.prepare(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(reused.root.path == prepared.root.path)
            #expect(try String(contentsOf: reused.root.appendingPathComponent("version-probes"), encoding: .utf8) ==
                "probe\n")
        }
        let app = try #require(Bundle(url: home.appendingPathComponent("archive-2.app")))
        let upgraded = try await BundledRuntime.seed(bundle: app, profile: profile, homeDirectory: home)
        #expect(upgraded.root.lastPathComponent == "archive-2")
        let rollback = try await BundledRuntime.seed(bundle: looseBundle, profile: profile, homeDirectory: home)
        #expect(rollback.root.path == loose.root.path)
        #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.path == loose.root.path)
    }

    @Test(arguments: [false, true])
    func `helper preparation bounds extracted copies without adopting the terminal CLI`(
        existingCLI: Bool) async throws
    {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: [:])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let directory = state.appendingPathComponent("runtime")
        let cli = state.appendingPathComponent("bin/openclaw")
        if existingCLI {
            let app = home.appendingPathComponent("Loose.app")
            _ = try self.makeBundle(at: app, builtAt: "old", buildID: "loose-build", command: "unused")
            _ = try await BundledRuntime.seed(bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        }
        let originalCLI = try? Data(contentsOf: cli)
        for index in 0...3 {
            let app = home.appendingPathComponent("Helper-\(index).app")
            _ = try await self.makeArchive(at: app, buildID: "helper-\(index)")
            _ = try await BundledRuntime.prepare(
                bundle: #require(Bundle(url: app)),
                profile: profile,
                homeDirectory: home)
        }
        let contents = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        let expected = ["helper-2", "helper-3", "helper-current", "helper-previous"]
            + (existingCLI ? ["current", "loose-build"] : [])
        #expect(contents == expected.sorted())
        #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home)?.root.lastPathComponent
            == (existingCLI ? "loose-build" : nil))
        #expect((try? Data(contentsOf: cli)) == originalCLI)
    }

    @Test func `damaged helper retention metadata does not block a verified runtime`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: [:])
        let directory = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let damaged = directory.appendingPathComponent("helper-current")
        let bytes = Data("interrupted metadata".utf8)
        try bytes.write(to: damaged)
        let app = home.appendingPathComponent("Helper.app")
        _ = try await self.makeArchive(at: app, buildID: "helper-build")
        let runtime = try await BundledRuntime.prepare(
            bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        #expect(runtime.root.lastPathComponent == "helper-build")
        #expect(FileManager.default.isExecutableFile(atPath: runtime.bun.path))
        #expect(try Data(contentsOf: damaged) == bytes)
        #expect(try BundledRuntime.seeded(profile: profile, homeDirectory: home) == nil)
    }
}
