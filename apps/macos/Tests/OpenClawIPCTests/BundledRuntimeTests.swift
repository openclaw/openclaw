import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct BundledRuntimeTests {
    private func makeBundle(at root: URL, builtAt: String, command: String) throws -> URL {
        let info: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.mac.debug",
            "CFBundleExecutable": "OpenClaw",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "2026.8.1",
            "CFBundleVersion": "1",
            "OpenClawGitCommit": String(repeating: "a", count: 40),
            "OpenClawBuildTimestamp": builtAt,
            "OpenClawRuntimeBuildID": builtAt,
        ]
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("Contents/MacOS"),
            withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: root.appendingPathComponent("Contents/Info.plist"))
        let runtime = root.appendingPathComponent("Contents/Resources/runtime")
        let dist = runtime.appendingPathComponent("lib/node_modules/openclaw/dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: runtime.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        // A real child process protects selection/lifecycle; package proof runs actual Bun separately.
        try "#!/bin/sh\nexec /bin/sh \"$@\"\n".write(
            to: runtime.appendingPathComponent("bin/bun"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: runtime.appendingPathComponent("bin/bun").path)
        try Data().write(to: runtime.appendingPathComponent("lib/libsqlite3.dylib"))
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.8.1", "commit": String(repeating: "a", count: 40),
            "builtAt": builtAt, "buildId": builtAt,
        ]).write(to: dist.appendingPathComponent("build-info.json"))
        try """
        runtime="${0%/lib/node_modules/openclaw/dist/mac-node-worker.js}"
        [ "${PATH%%:*}" = "$runtime/bin" ] || exit 91
        printf '{"type":"ready","version":"2026.8.1","manifest":{"caps":["system"],"commands":["\(
            command)"],"pathEnv":"%s"}}\\n' "$OPENCLAW_SQLITE_LIBRARY"
        while IFS= read -r line; do :; done
        """.write(to: dist.appendingPathComponent("mac-node-worker.js"), atomically: true, encoding: .utf8)
        let browser = dist.appendingPathComponent("extensions/browser")
        try FileManager.default.createDirectory(at: browser, withIntermediateDirectories: true)
        try "exit 0\n".write(to: browser.appendingPathComponent("setup-entry.js"), atomically: true, encoding: .utf8)
        return dist
    }

    @Test func `dirty same-SHA rebuild selects relocated worker over accepted external CLI`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let external = root.appendingPathComponent("external/openclaw")
        try makeExecutableForTests(at: external)
        let suiteName = "BundledRuntimeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(external.path, forKey: cliValidatedExecutableKey)
        defaults.set("2026.8.1", forKey: cliValidatedVersionKey)
        #expect(CommandResolver.validatedOpenClawExecutable(
            defaults: defaults, fileManager: .default, requiredVersion: "2026.8.1") == external.path)

        let worker = MacNodeHostWorker(session: GatewayNodeSession())
        for (index, command) in ["worker.before", "worker.dirty"].enumerated() {
            let source = root.appendingPathComponent("source-\(index)")
            let app = source.appendingPathComponent("OpenClaw.app")
            _ = try self.makeBundle(at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", command: command)
            let relocated = root.appendingPathComponent("relocated-\(index)/OpenClaw.app")
            try FileManager.default.createDirectory(
                at: relocated.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: app, to: relocated)
            try FileManager.default.removeItem(at: source)
            let bundle = try #require(Bundle(url: relocated))
            let launch = try await CommandResolver.nodeHostWorkerLaunch(
                bundle: bundle, projectRoot: source, searchPaths: [external.deletingLastPathComponent().path])
            do {
                let manifest = try await worker.start(launch: launch)
                #expect(manifest.commands == [command])
                #expect(launch.command[0] == relocated.appendingPathComponent("Contents/Resources/runtime/bin/bun")
                    .path)
                #expect(manifest.pathEnv == relocated
                    .appendingPathComponent("Contents/Resources/runtime/lib/libsqlite3.dylib").path)
                #expect(!launch.command.contains(external.path))
            } catch {
                await worker.stop()
                throw error
            }
        }
        await worker.stop()
    }

    @Test(arguments: ["missing", "bun", "sqlite", "version", "commit", "builtAt", "buildId"])
    func `incomplete payload never falls back to development source`(failure: String) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("OpenClaw.app")
        let dist = try makeBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let info = dist.appendingPathComponent("build-info.json")
        if failure == "missing" {
            try FileManager.default.removeItem(at: info)
        } else if failure == "bun" || failure == "sqlite" {
            let path = failure == "bun" ? "bin/bun" : "lib/libsqlite3.dylib"
            try FileManager.default.removeItem(at: app.appendingPathComponent("Contents/Resources/runtime/\(path)"))
        } else {
            var payload = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: info)) as? [String: String])
            payload[failure] = "mismatched"
            try JSONSerialization.data(withJSONObject: payload).write(to: info)
        }
        let bundle = try #require(Bundle(url: app))
        await #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try await CommandResolver.nodeHostWorkerLaunch(bundle: bundle, projectRoot: root, searchPaths: [])
        }
        #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try BundledRuntime.browserSetupLaunch(bundle: bundle)
        }
    }

    @Test func `browser setup uses relocated private runtime and the node profile without an external CLI`() throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("OpenClaw.app")
        _ = try self.makeBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let relocated = root.appendingPathComponent("Moved.app")
        try FileManager.default.moveItem(at: app, to: relocated)
        let bundle = try #require(Bundle(url: relocated))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "browser-fixture"])
        let runtime = try BundledRuntime.resolve(bundle: bundle)
        let worker = try BundledRuntime.launch(bundle: bundle, profile: profile)
        let setup = try BundledRuntime.browserSetupLaunch(bundle: bundle, profile: profile)
        #expect(setup.command[0] == worker.command[0])
        #expect(setup.command[1].hasSuffix("/dist/extensions/browser/setup-entry.js"))
        #expect(worker.command[1].hasSuffix("/dist/mac-node-worker.js"))
        #expect(runtime.root == relocated.appendingPathComponent("Contents/Resources/runtime"))
        #expect(runtime.bun == runtime.root.appendingPathComponent("bin/bun"))
        #expect(runtime.packageRoot == runtime.root.appendingPathComponent("lib/node_modules/openclaw"))
        #expect(setup.command[0] == runtime.bun.path)
        #expect(Array(setup.command.dropFirst(2)) == [
            "--action", "install", "--wait-ms", "1000",
        ])
        #expect(setup.currentDirectoryURL == worker.currentDirectoryURL)
        #expect(setup.currentDirectoryURL == runtime.packageRoot)
        #expect(setup.environment["PATH"] == worker.environment["PATH"])
        #expect(setup.environment["PATH"] == runtime.root.appendingPathComponent("bin").path)
        #expect(setup.environment["OPENCLAW_SQLITE_LIBRARY"] == worker.environment["OPENCLAW_SQLITE_LIBRARY"])
        #expect(setup.environment["OPENCLAW_SQLITE_LIBRARY"] == runtime.root
            .appendingPathComponent("lib/libsqlite3.dylib").path)
        #expect(setup.environment["OPENCLAW_PROFILE"] == "browser-fixture")
    }
}
