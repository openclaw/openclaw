import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct BundledRuntimeTests {
    @Test func `dirty same-SHA rebuild selects relocated worker over accepted external CLI`() async throws {
        let root = try makeFirstRunTempDirForTests()
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
            _ = try makeBundledRuntimeTestBundle(at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", command: command)
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
                #expect(URL(fileURLWithPath: launch.command[0]).resolvingSymlinksInPath() == relocated
                    .appendingPathComponent("Contents/Resources/runtime/openclaw").resolvingSymlinksInPath())
                #expect(manifest.pathEnv.isEmpty)
                #expect(!launch.command.contains(external.path))
            } catch {
                await worker.stop()
                throw error
            }
        }
        await worker.stop()
    }

    @Test(arguments: [
        "missing", "executable", "sidecar", "sqlite", "version", "commit", "buildId", "mode", "schemaVersion",
        "executablePath", "runtimePath", "executableSize", "runtimeSize",
    ])
    func `incomplete payload never falls back to development source`(failure: String) async throws {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("OpenClaw.app")
        let dist = try makeBundledRuntimeTestBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let info = dist.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("manifest.json")
        if failure == "missing" {
            try FileManager.default.removeItem(at: info)
        } else if failure == "executable" || failure == "sidecar" || failure == "sqlite" {
            let path = failure == "executable" ? "openclaw" : failure == "sidecar" ? "runtime" : "runtime/lib/libsqlite3.dylib"
            try FileManager.default.removeItem(at: app.appendingPathComponent("Contents/Resources/runtime/\(path)"))
        } else {
            var payload = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: info)) as? [String: Any])
            if failure == "version" || failure == "commit" {
                var identity = try #require(payload["openclaw"] as? [String: String])
                identity[failure] = "mismatched"
                payload["openclaw"] = identity
            } else if failure == "schemaVersion" {
                payload[failure] = 2
            } else if failure.hasSuffix("Path") || failure.hasSuffix("Size") {
                let field = failure.hasPrefix("executable") ? "executable" : "runtime"
                var entry = try #require(payload[field] as? [String: Any])
                entry[failure.hasSuffix("Path") ? "path" : "sizeBytes"] = failure.hasSuffix("Path")
                    ? "../outside" : -1
                payload[field] = entry
            } else { payload[failure] = "mismatched" }
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
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let app = root.appendingPathComponent("OpenClaw.app")
        _ = try makeBundledRuntimeTestBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
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
        #expect(runtime.root.resolvingSymlinksInPath() == relocated
            .appendingPathComponent("Contents/Resources/runtime").resolvingSymlinksInPath())
        #expect(runtime.executable == runtime.root.appendingPathComponent("openclaw"))
        #expect(runtime.packageRoot == runtime.root.appendingPathComponent("runtime"))
        #expect(setup.command[0] == runtime.executable.path)
        #expect(Array(setup.command.dropFirst(2)) == [
            "--action", "install", "--wait-ms", "1000",
        ])
        #expect(setup.currentDirectoryURL == worker.currentDirectoryURL)
        #expect(setup.currentDirectoryURL == runtime.packageRoot)
        #expect(setup.environment["PATH"] == worker.environment["PATH"])
        #expect(setup.environment["PATH"] == runtime.root.path)
        #expect(worker.environment["OPENCLAW_SQLITE_LIBRARY"] == nil)
        #expect(setup.environment["OPENCLAW_SQLITE_LIBRARY"] == nil)
        #expect(setup.environment["OPENCLAW_PROFILE"] == "browser-fixture")
    }

    @Test(arguments: [false, true], [false, true])
    func `retained runtime launches preserve recorded SQLite overrides and legacy fallback`(
        standalone: Bool,
        recordedOverride: Bool)
    {
        let root = URL(fileURLWithPath: "/fixture/previous")
        let cli = GatewayLaunchAgentManager.InstalledServiceCLI(
            prefix: standalone ? [root.appendingPathComponent("openclaw").path] : [
                root.appendingPathComponent("bin/bun").path,
                root.appendingPathComponent("lib/node_modules/openclaw/openclaw.mjs").path,
            ],
            sqliteLibrary: recordedOverride ? "/fixture/retained/libsqlite3.dylib" : nil)
        let runtime = BundledRuntime(retainedCLI: cli)
        let expected = recordedOverride ? "/fixture/retained/libsqlite3.dylib" :
            standalone ? nil : "/fixture/previous/lib/libsqlite3.dylib"
        #expect(runtime.environment["OPENCLAW_SQLITE_LIBRARY"] == expected)
    }

    @Test func `app hosting selects the bundle without seeding or executing it`() throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("NoProbe.app")
        _ = try makeBundledRuntimeTestBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "no-probe"])
        let runtime = try BundledRuntime.forAppHosting(
            bundle: #require(Bundle(url: app)),
            profile: profile,
            homeDirectory: home)
        #expect(!FileManager.default.fileExists(atPath: runtime.root.appendingPathComponent("version-probes").path))
        #expect(FileManager.default.isExecutableFile(atPath: runtime.executable.path))
        #expect(runtime.root.resolvingSymlinksInPath().path == app
            .appendingPathComponent("Contents/Resources/runtime").resolvingSymlinksInPath().path)
        #expect(!FileManager.default.fileExists(atPath: profile.stateDirectoryURL(homeDirectory: home).path))
    }

    @Test func `a resealed bundle reuses its intact seed with the same build identity`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let app = home.appendingPathComponent("Resealed.app")
        _ = try makeBundledRuntimeTestBundle(at: app, builtAt: "2026-08-27T00:00:00.000Z", command: "unused")
        let bundle = try #require(Bundle(url: app))
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "resealed"])
        let first = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        let original = try Data(contentsOf: first.executable)
        let source = try BundledRuntime.resolve(bundle: bundle)
        var resealed = original
        resealed.append(Data("# new signature bytes\n".utf8))
        try resealed.write(to: source.executable)
        let manifestURL = source.root.appendingPathComponent("manifest.json")
        var manifest = try #require(JSONSerialization.jsonObject(
            with: Data(contentsOf: manifestURL)) as? [String: Any])
        manifest["executable"] = [
            "path": "openclaw", "sizeBytes": resealed.count,
            "sha256": SHA256.hash(data: resealed).map { String(format: "%02x", $0) }.joined(),
        ]
        try JSONSerialization.data(withJSONObject: manifest).write(to: manifestURL)

        let reused = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        #expect(reused.root.path == first.root.path)
        #expect(try Data(contentsOf: reused.executable) == original)
        #expect(try String(contentsOf: reused.root.appendingPathComponent("version-probes"), encoding: .utf8) ==
            "probe\n")
    }

    @Test func `seeding publishes a relocatable current runtime after warming it once`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "seed-fixture"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let runtimeRoot = state.appendingPathComponent("runtime")
        let shellProfile = home.appendingPathComponent(".zshrc")
        try "# existing settings\n".write(to: shellProfile, atomically: true, encoding: .utf8)

        for index in 0...1 {
            let app = home.appendingPathComponent("Build-\(index).app")
            _ = try makeBundledRuntimeTestBundle(
                at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", buildID: "build-\(index)", command: "unused")
            let bundle = try #require(Bundle(url: app))
            let seeded = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(seeded.root.path == runtimeRoot.appendingPathComponent("build-\(index)").path)
            #expect(try FileManager.default.destinationOfSymbolicLink(
                atPath: runtimeRoot.appendingPathComponent("current").path) == "build-\(index)")
            #expect(try String(contentsOf: seeded.root.appendingPathComponent("version-probes"), encoding: .utf8) ==
                "probe\n")
            let readOnly = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
            #expect(readOnly.cliCommand == seeded.cliCommand)
            let result = await ShellExecutor.runDetailed(
                command: [state.appendingPathComponent("bin/openclaw").path, "argument with spaces"],
                cwd: nil,
                env: [:],
                timeout: 5)
            #expect(result.success)
            #expect(result
                .stdout ==
                "seed-fixture\n\nargument with spaces\n")
        }
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: runtimeRoot.appendingPathComponent("previous").path) == "build-0")
        let shellText = try String(contentsOf: shellProfile, encoding: .utf8)
        #expect(shellText == "# existing settings\n")

        let brokenApp = home.appendingPathComponent("Broken.app")
        _ = try makeBundledRuntimeTestBundle(
            at: brokenApp, builtAt: "2026-08-27T00:00:02.000Z", buildID: "broken-build", command: "unused")
        try "#!/bin/sh\nexit 42\n".write(
            to: brokenApp.appendingPathComponent("Contents/Resources/runtime/openclaw"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: brokenApp.appendingPathComponent("Contents/Resources/runtime/openclaw").path)
        let broken = try #require(Bundle(url: brokenApp))
        await #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try await BundledRuntime.seed(bundle: broken, profile: profile, homeDirectory: home)
        }
        #expect(!FileManager.default.fileExists(atPath: brokenApp
                .appendingPathComponent("Contents/Resources/runtime/version-probes").path))
        let corruptApp = home.appendingPathComponent("Corrupt.app")
        _ = try makeBundledRuntimeTestBundle(
            at: corruptApp, builtAt: "2026-08-27T00:00:03.000Z", buildID: "corrupt-build", command: "unused")
        let corruptExecutable = corruptApp.appendingPathComponent("Contents/Resources/runtime/openclaw")
        var bytes = try Data(contentsOf: corruptExecutable)
        bytes[bytes.count - 2] ^= 1
        try bytes.write(to: corruptExecutable)
        await #expect(throws: BundledRuntime.ValidationError.self) {
            try await BundledRuntime.seed(
                bundle: #require(Bundle(url: corruptApp)), profile: profile, homeDirectory: home)
        }
        #expect(!FileManager.default.fileExists(atPath: runtimeRoot
                .appendingPathComponent("corrupt-build/version-probes").path))
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: runtimeRoot.appendingPathComponent("current").path) == "build-1")
        #expect(try FileManager.default.contentsOfDirectory(atPath: runtimeRoot.path)
            .allSatisfy { !$0.contains(".partial-") && $0 != "broken-build" })
    }

    @Test func `loose runtime upgrades on first seed and retires only after another healthy build`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "loose-upgrade"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let directory = state.appendingPathComponent("runtime")
        let legacy = directory.appendingPathComponent("loose-build/lib/node_modules/openclaw/dist")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        try Data(#"{"buildId":"loose-build"}"#.utf8).write(to: legacy.appendingPathComponent("build-info.json"))
        try FileManager.default.createSymbolicLink(
            atPath: directory.appendingPathComponent("current").path,
            withDestinationPath: "loose-build")
        let cli = state.appendingPathComponent("bin/openclaw")
        try FileManager.default.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\n# OpenClaw.app managed CLI (bundled runtime)\nexec broken-bun\n"
            .write(to: cli, atomically: true, encoding: .utf8)
        #expect(throws: BundledRuntime.SeedError.self) {
            try BundledRuntime.seeded(profile: profile, homeDirectory: home)
        }

        for index in 1...2 {
            let app = home.appendingPathComponent("Upgrade-\(index).app")
            _ = try makeBundledRuntimeTestBundle(
                at: app,
                builtAt: "2026-08-27T00:00:0\(index).000Z",
                buildID: "standalone-\(index)",
                command: "unused")
            let runtime = try await BundledRuntime.seed(
                bundle: #require(Bundle(url: app)),
                profile: profile,
                homeDirectory: home)
            #expect(runtime.cliCommand == [directory.appendingPathComponent("standalone-\(index)/openclaw").path])
            let result = await ShellExecutor.runDetailed(command: [cli.path, "doctor"], cwd: nil, env: [:], timeout: 5)
            #expect(result.success)
            #expect(result.stdout.hasSuffix("doctor\n"))
            try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: home)
            #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("loose-build").path)
                == (index == 1))
        }
    }

    @Test func `seeding replaces only the managed CLI wrapper and preserves operator commands`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "shim-fixture"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let cli = state.appendingPathComponent("bin/openclaw")
        try FileManager.default.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        let managedEntry = state.appendingPathComponent("tools/node-v24.16.0/lib/node_modules/openclaw/dist/entry.js")
        let managed = """
        #!/usr/bin/env bash
        set -euo pipefail
        exec "\(state.path)/tools/node/bin/node" "\(managedEntry.path)" "$@"

        """
        try managed.write(to: cli, atomically: true, encoding: .utf8)
        let app = home.appendingPathComponent("Fixture.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "shim-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        let result = await ShellExecutor.runDetailed(command: [cli.path], cwd: nil, env: [:], timeout: 5)
        #expect(result.success)
        #expect(result.stdout == "shim-fixture\n\n")
        let operatorScript = "#!/bin/sh\nexec /custom/openclaw \"$@\"\n"
        try operatorScript.write(to: cli, atomically: true, encoding: .utf8)
        _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        #expect(try String(contentsOf: cli, encoding: .utf8) == operatorScript)
        try FileManager.default.removeItem(at: cli)
        let operatorTarget = home.appendingPathComponent("operator-command")
        try managed.write(to: operatorTarget, atomically: true, encoding: .utf8)
        try FileManager.default.createSymbolicLink(at: cli, withDestinationURL: operatorTarget)
        _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: cli.path) == operatorTarget.path)
        #expect(try String(contentsOf: operatorTarget, encoding: .utf8) == managed)
    }

    @Test
    func `shell integration conflicts preserve operator files without blocking runtime preparation`() async throws {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let dotfiles = root.appendingPathComponent("dotfiles")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dotfiles, withIntermediateDirectories: true)
        let operatorSettings = dotfiles.appendingPathComponent("zshrc")
        try "# operator settings\n".write(to: operatorSettings, atomically: true, encoding: .utf8)
        let zshrc = home.appendingPathComponent(".zshrc")
        try FileManager.default.createSymbolicLink(at: zshrc, withDestinationURL: operatorSettings)
        let bashrc = home.appendingPathComponent(".bashrc")
        try "# existing bash settings\n".write(to: bashrc, atomically: true, encoding: .utf8)
        let unsupportedProfile = home.appendingPathComponent(".profile")
        try FileManager.default.createDirectory(at: unsupportedProfile, withIntermediateDirectories: true)
        let profile = AppProfile(environment: [:])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let macCLI = state.appendingPathComponent("bin/openclaw-mac")
        try FileManager.default.createDirectory(
            at: macCLI.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try "operator command\n".write(to: macCLI, atomically: true, encoding: .utf8)
        let app = root.appendingPathComponent("Fixture.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "shell-build", command: "unused")
        let runtime = try await BundledRuntime.seed(
            bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        #expect(runtime.root.path == state.appendingPathComponent("runtime/shell-build").path)
        #expect(FileManager.default.isExecutableFile(atPath: state.appendingPathComponent("bin/openclaw").path))
        #expect(try String(contentsOf: operatorSettings, encoding: .utf8) == "# operator settings\n")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: zshrc.path) == operatorSettings.path)
        #expect(try String(contentsOf: macCLI, encoding: .utf8) == "operator command\n")
        #expect(try unsupportedProfile.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)
        #expect(try String(contentsOf: bashrc, encoding: .utf8)
            == "export PATH=\"\(state.path)/bin:$PATH\"\n# existing bash settings\n")
        try FileManager.default.removeItem(at: macCLI)
        let missingOperatorCLI = root.appendingPathComponent("Other.app/Contents/MacOS/openclaw-mac")
        try FileManager.default.createSymbolicLink(at: macCLI, withDestinationURL: missingOperatorCLI)
        _ = try await BundledRuntime.seed(
            bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: macCLI.path) == missingOperatorCLI.path)
    }

    @Test(arguments: [false, true])
    @MainActor
    func `declined transient integration preserves Mac CLI links and the portable CLI shim`(
        existingLink: Bool) async throws
    {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "deferred-cli"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let app = root.appendingPathComponent("Installed.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "installed-build", command: "unused")
        let stableBundle = try #require(Bundle(url: app))
        let runtime = try await BundledRuntime.seed(bundle: stableBundle, profile: profile, homeDirectory: home)
        let link = state.appendingPathComponent("bin/openclaw-mac")
        let previousTarget = try FileManager.default.destinationOfSymbolicLink(atPath: link.path)
        if !existingLink { try FileManager.default.removeItem(at: link) }
        let shim = state.appendingPathComponent("bin/openclaw")
        try FileManager.default.removeItem(at: shim)
        let temporaryApp = home.appendingPathComponent("Downloads/OpenClaw.app")
        _ = try makeBundledRuntimeTestBundle(
            at: temporaryApp, builtAt: "2026-08-27T00:00:01.000Z", buildID: "download-build", command: "unused")
        let temporaryBundle = try #require(Bundle(url: temporaryApp))
        let allowed = !ApplicationRelocator.isTransientLocation(
            temporaryBundle.bundleURL, homeDirectory: home, isReadOnlyVolume: false)
        try #require(!allowed)

        BundledRuntime.refreshOwnedMacCLILink(
            bundle: temporaryBundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: allowed)
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) ==
            (existingLink ? previousTarget : nil))
        #expect(!FileManager.default.fileExists(atPath: shim.path))
        runtime.installCLI(
            bundle: temporaryBundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: allowed)
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) ==
            (existingLink ? previousTarget : nil))
        #expect(FileManager.default.isExecutableFile(atPath: shim.path))
        let seeded = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
        #expect(seeded.root.path == runtime.root.path)
    }

    @Test(arguments: [(false, true), (true, true), (false, false)])
    func `only the persistent default profile adds its CLI to shell startup files`(
        namedProfile: Bool,
        allowsPersistentIntegration: Bool) throws
    {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let shellProfile = home.appendingPathComponent(".zshrc")
        try "# existing settings\n".write(to: shellProfile, atomically: true, encoding: .utf8)
        let profile = AppProfile(environment: namedProfile ? ["OPENCLAW_PROFILE": "shell-fixture"] : [:])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let app = root.appendingPathComponent("Fixture.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "shell-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        let runtime = BundledRuntime(root: app.appendingPathComponent("Contents/Resources/runtime"))

        for _ in 0..<2 {
            runtime.installCLI(
                bundle: bundle,
                profile: profile,
                homeDirectory: home,
                allowsPersistentIntegration: allowsPersistentIntegration)
            #expect(FileManager.default.isExecutableFile(atPath: state.appendingPathComponent("bin/openclaw").path))
            let shellText = try String(contentsOf: shellProfile, encoding: .utf8)
            if allowsPersistentIntegration, !namedProfile {
                #expect(shellText == "export PATH=\"\(home.path)/.openclaw/bin:$PATH\"\n# existing settings\n")
            } else {
                #expect(shellText == "# existing settings\n")
                #expect(try Set(FileManager.default.contentsOfDirectory(atPath: home.path)) ==
                    Set([".zshrc", state.lastPathComponent]))
            }
        }
    }

    @Test func `owned mac CLI link follows app moves without seeding or creating terminal commands`() throws {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "mac-cli-move"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        var app = root.appendingPathComponent("Original.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "move-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        BundledRuntime.refreshOwnedMacCLILink(
            bundle: bundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: true)
        #expect(!FileManager.default.fileExists(atPath: state.path))
        let runtime = BundledRuntime(root: app.appendingPathComponent("Contents/Resources/runtime"))
        runtime.installCLI(bundle: bundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: true)
        let command = state.appendingPathComponent("bin/openclaw-mac")
        try #require(FileManager.default.isExecutableFile(atPath: command.path))
        let terminalCLI = state.appendingPathComponent("bin/openclaw")
        try FileManager.default.removeItem(at: terminalCLI)

        for name in ["Moved.app", "MovedAgain.app"] {
            let moved = root.appendingPathComponent(name)
            try FileManager.default.moveItem(at: app, to: moved)
            #expect(!FileManager.default.isExecutableFile(atPath: command.path))
            let movedBundle = try #require(Bundle(url: moved))
            BundledRuntime.refreshOwnedMacCLILink(
                bundle: movedBundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: true)
            #expect(try FileManager.default.destinationOfSymbolicLink(atPath: command.path) ==
                movedBundle.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac").path)
            #expect(FileManager.default.isExecutableFile(atPath: command.path))
            #expect(!FileManager.default.fileExists(atPath: terminalCLI.path))
            #expect(!FileManager.default.fileExists(atPath: state.appendingPathComponent("runtime").path))
            app = moved
        }
    }

    @Test(arguments: [false, true])
    func `matching operator mac CLI links are never adopted`(mismatchedOwnership: Bool) throws {
        let root = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "operator-mac-cli"])
        let command = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("bin/openclaw-mac")
        let app = root.appendingPathComponent("Original.app")
        _ = try makeBundledRuntimeTestBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "operator-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        let originalTarget = bundle.bundleURL.appendingPathComponent("Contents/MacOS/openclaw-mac").path
        try FileManager.default.createDirectory(
            at: command.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: command.path, withDestinationPath: originalTarget)
        if mismatchedOwnership {
            let metadata = Data("/different/app/openclaw-mac".utf8)
            let result = metadata.withUnsafeBytes {
                setxattr(command.path, "ai.openclaw.mac-cli-target", $0.baseAddress, metadata.count, 0, XATTR_NOFOLLOW)
            }
            try #require(result == 0)
        }
        BundledRuntime(root: app.appendingPathComponent("Contents/Resources/runtime"))
            .installCLI(bundle: bundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: true)
        let moved = root.appendingPathComponent("Moved.app")
        try FileManager.default.moveItem(at: app, to: moved)
        let movedBundle = try #require(Bundle(url: moved))
        BundledRuntime.refreshOwnedMacCLILink(
            bundle: movedBundle, profile: profile, homeDirectory: home, allowsPersistentIntegration: true)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: command.path) == originalTarget)
    }

    @Test func `healthy collection retains the previous build and any live runtime executable`() async throws {
        let home = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "gc-fixture"])
        let directory = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime")
        for index in 0...2 {
            let app = home.appendingPathComponent("GC-\(index).app")
            _ = try makeBundledRuntimeTestBundle(
                at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", buildID: "gc-\(index)", command: "unused")
            _ = try await BundledRuntime.seed(
                bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        }

        // A copied native executable exercises the kernel's real process-path boundary.
        // stdin keeps it alive without timers, sleeps, or a Gateway process.
        let executable = directory.appendingPathComponent("gc-0/retained-process")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/cat"), to: executable)
        // The system signature rejects relocation. This standalone fixture has no app or Keychain access.
        let signed = await ShellExecutor.runDetailed(
            command: ["/usr/bin/codesign", "--force", "--sign", "-", executable.path],
            cwd: nil,
            env: [:],
            timeout: 5)
        try #require(signed.success, "Fixture signing failed: \(signed.stderr)")
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = executable
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        let ready = Data("ready\n".utf8)
        try input.fileHandleForWriting.write(contentsOf: ready)
        try #require(try output.fileHandleForReading.read(upToCount: ready.count) == ready)
        try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: home)
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("gc-0").path))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: home)
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("gc-0").path))
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("gc-1").path))
        #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("gc-2").path))
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: directory.appendingPathComponent("current").path) == "gc-2")
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: directory.appendingPathComponent("previous").path) == "gc-1")

        try FileManager.default.removeItem(at: directory.appendingPathComponent("current"))
        for index in 3...4 {
            let app = home.appendingPathComponent("GC-\(index).app")
            _ = try makeBundledRuntimeTestBundle(
                at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", buildID: "gc-\(index)", command: "unused")
            let seeded = try await BundledRuntime.seed(
                bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
            let resolved = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
            #expect(resolved.root.path == seeded.root.path)
            try await BundledRuntime.garbageCollectAfterHealthy(profile: profile, homeDirectory: home)
            for retainedAfterRecovery in ["gc-1", "gc-2"] {
                #expect(FileManager.default.fileExists(atPath: directory
                        .appendingPathComponent(retainedAfterRecovery).path) == (index == 3))
            }
            #expect((try? FileManager.default.destinationOfSymbolicLink(
                atPath: directory.appendingPathComponent("previous").path)) == (index == 3 ? nil : "gc-3"))
            #expect(FileManager.default.fileExists(atPath: directory.appendingPathComponent("gc-3").path))
        }
    }
}
