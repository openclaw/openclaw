import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct BundledRuntimeTests {
    private func makeBundle(at root: URL, builtAt: String, buildID: String? = nil, command: String) throws -> URL {
        let info: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.mac.debug",
            "CFBundleExecutable": "OpenClaw",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "2026.8.1",
            "CFBundleVersion": "1",
            "OpenClawGitCommit": String(repeating: "a", count: 40),
            "OpenClawBuildTimestamp": builtAt,
            "OpenClawRuntimeBuildID": buildID ?? builtAt,
        ]
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("Contents/MacOS"),
            withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: root.appendingPathComponent("Contents/Info.plist"))
        try makeExecutableForTests(at: root.appendingPathComponent("Contents/MacOS/openclaw-mac"))
        let runtime = root.appendingPathComponent("Contents/Resources/runtime")
        let dist = runtime.appendingPathComponent("lib/node_modules/openclaw/dist")
        try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: runtime.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        // A real child process protects selection/lifecycle; package proof runs actual Bun separately.
        try """
        #!/bin/sh
        if [ "$1" = --version ]; then
          echo probe >> "${0%/bin/bun}/version-probes"
          echo 1.4.0
          exit 0
        fi
        exec /bin/sh "$@"

        """.write(
            to: runtime.appendingPathComponent("bin/bun"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: runtime.appendingPathComponent("bin/bun").path)
        try Data().write(to: runtime.appendingPathComponent("lib/libsqlite3.dylib"))
        try "printf '%s\\n' \"$OPENCLAW_PROFILE\" \"$OPENCLAW_SQLITE_LIBRARY\" \"$@\"\n".write(
            to: runtime.appendingPathComponent("lib/node_modules/openclaw/openclaw.mjs"),
            atomically: true,
            encoding: .utf8)
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.8.1", "commit": String(repeating: "a", count: 40),
            "builtAt": builtAt, "buildId": buildID ?? builtAt,
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

    @Test func `seeding publishes a relocatable current runtime and probes each copied build once`() async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "seed-fixture"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let runtimeRoot = state.appendingPathComponent("runtime")
        let shellProfile = home.appendingPathComponent(".zshrc")
        try "# existing settings\n".write(to: shellProfile, atomically: true, encoding: .utf8)

        for index in 0...1 {
            let app = home.appendingPathComponent("Build-\(index).app")
            _ = try self.makeBundle(
                at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", buildID: "build-\(index)", command: "unused")
            let bundle = try #require(Bundle(url: app))
            let seeded = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
            #expect(seeded.root.path == runtimeRoot.appendingPathComponent("build-\(index)").path)
            #expect(try FileManager.default.destinationOfSymbolicLink(
                atPath: runtimeRoot.appendingPathComponent("current").path) == "build-\(index)")
            #expect(try String(contentsOf: seeded.root.appendingPathComponent("version-probes"), encoding: .utf8)
                == "probe\n")
            let readOnly = try #require(try BundledRuntime.seeded(profile: profile, homeDirectory: home))
            #expect(readOnly.cliCommand == seeded.cliCommand)
            let result = await ShellExecutor.runDetailed(
                command: [state.appendingPathComponent("bin/openclaw").path, "argument with spaces"],
                cwd: nil,
                env: [:],
                timeout: 5)
            #expect(result.success)
            #expect(result
                .stdout == "seed-fixture\n\(runtimeRoot.path)/current/lib/libsqlite3.dylib\nargument with spaces\n")
        }
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: runtimeRoot.appendingPathComponent("previous").path) == "build-0")
        let shellText = try String(contentsOf: shellProfile, encoding: .utf8)
        #expect(shellText == "# existing settings\n")

        let brokenApp = home.appendingPathComponent("Broken.app")
        _ = try self.makeBundle(
            at: brokenApp, builtAt: "2026-08-27T00:00:02.000Z", buildID: "broken-build", command: "unused")
        try "#!/bin/sh\nexit 42\n".write(
            to: brokenApp.appendingPathComponent("Contents/Resources/runtime/bin/bun"),
            atomically: true,
            encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: brokenApp.appendingPathComponent("Contents/Resources/runtime/bin/bun").path)
        let broken = try #require(Bundle(url: brokenApp))
        await #expect(throws: BundledRuntime.SeedError.self) {
            try await BundledRuntime.seed(bundle: broken, profile: profile, homeDirectory: home)
        }
        #expect(try FileManager.default.destinationOfSymbolicLink(
            atPath: runtimeRoot.appendingPathComponent("current").path) == "build-1")
        #expect(try FileManager.default.contentsOfDirectory(atPath: runtimeRoot.path)
            .allSatisfy { !$0.contains(".partial-") && $0 != "broken-build" })
    }

    @Test func `seeding replaces only the managed CLI wrapper and preserves operator commands`() async throws {
        let home = try makeTempDirForTests()
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
        _ = try self.makeBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "shim-build", command: "unused")
        let bundle = try #require(Bundle(url: app))
        _ = try await BundledRuntime.seed(bundle: bundle, profile: profile, homeDirectory: home)
        let result = await ShellExecutor.runDetailed(command: [cli.path], cwd: nil, env: [:], timeout: 5)
        #expect(result.success)
        #expect(result.stdout == "shim-fixture\n\(state.path)/runtime/current/lib/libsqlite3.dylib\n")
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
        let root = try makeTempDirForTests()
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
        _ = try self.makeBundle(
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
    func `declined transient integration preserves Mac CLI links and the portable Bun shim`(
        existingLink: Bool) async throws
    {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "deferred-cli"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let app = root.appendingPathComponent("Installed.app")
        _ = try self.makeBundle(
            at: app, builtAt: "2026-08-27T00:00:00.000Z", buildID: "installed-build", command: "unused")
        let stableBundle = try #require(Bundle(url: app))
        let runtime = try await BundledRuntime.seed(bundle: stableBundle, profile: profile, homeDirectory: home)
        let link = state.appendingPathComponent("bin/openclaw-mac")
        let previousTarget = try FileManager.default.destinationOfSymbolicLink(atPath: link.path)
        if !existingLink { try FileManager.default.removeItem(at: link) }
        let shim = state.appendingPathComponent("bin/openclaw")
        try FileManager.default.removeItem(at: shim)
        let temporaryApp = home.appendingPathComponent("Downloads/OpenClaw.app")
        _ = try self.makeBundle(
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
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let shellProfile = home.appendingPathComponent(".zshrc")
        try "# existing settings\n".write(to: shellProfile, atomically: true, encoding: .utf8)
        let profile = AppProfile(environment: namedProfile ? ["OPENCLAW_PROFILE": "shell-fixture"] : [:])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let app = root.appendingPathComponent("Fixture.app")
        _ = try self.makeBundle(
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
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "mac-cli-move"])
        let state = profile.stateDirectoryURL(homeDirectory: home)
        var app = root.appendingPathComponent("Original.app")
        _ = try self.makeBundle(
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
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home")
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "operator-mac-cli"])
        let command = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("bin/openclaw-mac")
        let app = root.appendingPathComponent("Original.app")
        _ = try self.makeBundle(
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
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": "gc-fixture"])
        let directory = profile.stateDirectoryURL(homeDirectory: home).appendingPathComponent("runtime")
        for index in 0...2 {
            let app = home.appendingPathComponent("GC-\(index).app")
            _ = try self.makeBundle(
                at: app, builtAt: "2026-08-27T00:00:0\(index).000Z", buildID: "gc-\(index)", command: "unused")
            _ = try await BundledRuntime.seed(
                bundle: #require(Bundle(url: app)), profile: profile, homeDirectory: home)
        }

        // A copied native executable exercises the kernel's real process-path boundary.
        // stdin keeps it alive without timers, sleeps, or a Gateway process.
        let executable = directory.appendingPathComponent("gc-0/bin/retained-process")
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
            _ = try self.makeBundle(
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
