import Foundation
import Testing
@testable import OpenClaw

struct GatewayServiceRuntimeTests {
    private func snapshot(_ command: [String], sqliteLibrary: String? = nil) -> LaunchAgentPlistSnapshot {
        LaunchAgentPlistSnapshot(
            programArguments: command,
            environment: sqliteLibrary.map { ["OPENCLAW_SQLITE_LIBRARY": $0] } ?? [:],
            stdoutPath: nil, stderrPath: nil, port: nil, bind: nil, token: nil, password: nil)
    }

    @Test(arguments: [AppProfile(environment: [:]), AppProfile(environment: ["OPENCLAW_PROFILE": "legacy-fixture"])])
    func `legacy Node discovery follows only the profile owned package and canonical environment`(
        profile: AppProfile) throws
    {
        let home = try makeTempDirForTests().resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: home) }
        let state = profile.stateDirectoryURL(homeDirectory: home)
        let node = state.appendingPathComponent("tools/node-v26.1.0/bin/node")
        let package = state.appendingPathComponent("tools/node-v26.1.0/lib/node_modules/openclaw")
        let entry = package.appendingPathComponent("openclaw.mjs")
        let wrapper = state.appendingPathComponent("bin/openclaw")
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        for directory in [
            node.deletingLastPathComponent(),
            package,
            wrapper.deletingLastPathComponent(),
            artifacts.wrapper.deletingLastPathComponent(),
        ] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try Data("#!/bin/sh\nexit 92\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data("// synthetic package\n".utf8).write(to: entry)
        try Data(#"{"name":"openclaw","version":"2026.9.7"}"#.utf8)
            .write(to: package.appendingPathComponent("package.json"))
        try FileManager.default.createDirectory(
            at: state.appendingPathComponent("tools/node/bin"),
            withIntermediateDirectories: true)
        // A previous seed can replace the CLI wrapper without removing the legacy npm package.
        try Data("#!/bin/sh\n# OpenClaw.app managed CLI (bundled runtime)\n".utf8).write(to: wrapper)
        try Data("#!/bin/sh\nexec \"$@\"\n".utf8).write(to: artifacts.wrapper)
        try Data("export FIXTURE_CHANNEL='preserved'\n".utf8).write(to: artifacts.environment)
        #expect(try GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(profile: profile, homeDirectory: home))
        let cli = try #require(try GatewayLaunchAgentManager.legacyManagedNodeCLI(
            profile: profile, homeDirectory: home))
        #expect(cli.prefix.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path } ==
            [node, entry].map { $0.resolvingSymlinksInPath().path })
        #expect(cli.environment["FIXTURE_CHANNEL"] == "preserved")
        #expect(cli.usesGeneratedEnvironment)
        #expect(try !GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "other-fixture"]), homeDirectory: home))
        try Data("#!/bin/sh\nexec /operator/openclaw \"$@\"\n".utf8).write(to: wrapper)
        #expect(try !GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(profile: profile, homeDirectory: home))
        #expect(try GatewayLaunchAgentManager.legacyNodeInstallIsExternal(profile: profile, homeDirectory: home))
    }

    @MainActor
    @Test func `attach-only withdrawal blocks captured service install but permits inspection`() async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home) {
            let marker = home.appendingPathComponent("disable-launchagent")
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }
            let captured = GatewayLaunchAgentManager.InstalledServiceCLI(
                prefix: ["/operator/node", "/operator/openclaw.mjs"], sqliteLibrary: nil, hadRuntimePin: true)
            try Data().write(to: marker)
            #expect(await GatewayLaunchAgentManager.runDaemonCommand(["install", "--force"], installedCLI: captured) ==
                "Gateway service changes are disabled")
            #expect(await GatewayLaunchAgentManager
                .runDaemonCommand(["status", "--json"], installedCLI: captured) == nil)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot() == [["status", "--json"]])
        }
    }

    @Test func `fresh and replacement installs pin the selected bundled runtime`() {
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/profile/runtime/build-two"))
        for (exists, replace, expectedPin) in [
            (false, false, true),
            (true, false, false),
            (true, true, true),
        ] {
            let arguments = GatewayLaunchAgentManager.installArguments(
                port: 29871,
                allowUnconfigured: true,
                runtime: runtime,
                launchAgentExists: exists,
                replaceRuntime: replace)
            let expected = ["install", "--force", "--port", "29871", "--allow-unconfigured"]
                + (expectedPin ? ["--runtime", "bun", "--runtime-path", "/profile/runtime/build-two/bin/bun"] : [])
            #expect(arguments == expected)
        }
        #expect(GatewayLaunchAgentManager.installArguments(
            port: 29871,
            allowUnconfigured: false,
            runtime: nil,
            launchAgentExists: false) == ["install", "--force", "--port", "29871"])
    }

    @Test func `service install carries the selected build SQLite library and profile`() {
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/profile/runtime/build-two"))
        let environment = GatewayLaunchAgentManager.daemonEnvironment(
            runtime: runtime,
            environment: [
                "OPENCLAW_SQLITE_LIBRARY": "/old/libsqlite3.dylib", "OPENCLAW_PROFILE": "other",
                "OPENCLAW_STATE_DIR": "/other-profile", "OPENCLAW_CONFIG_PATH": "/other-profile/openclaw.json",
                "OPENCLAW_GATEWAY_HOST_LIFELINE": "stdin",
            ],
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "service-proof"]),
            searchPaths: ["/usr/bin", "/bin"])
        #expect(environment["OPENCLAW_SQLITE_LIBRARY"] == "/profile/runtime/build-two/lib/libsqlite3.dylib")
        #expect(environment["PATH"] == "/profile/runtime/build-two/bin:/usr/bin:/bin")
        #expect(environment["OPENCLAW_PROFILE"] == "service-proof")
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw-service-proof")
        #expect(environment["OPENCLAW_STATE_DIR"] == directory.path)
        #expect(environment["OPENCLAW_CONFIG_PATH"] == directory.appendingPathComponent("openclaw.json").path)
        #expect(environment["OPENCLAW_GATEWAY_HOST_LIFELINE"] == nil)
    }

    @Test func `app updates replace only app owned runtime intent`() {
        let stateDirectory = URL(fileURLWithPath: "/profile")
        for pin in ["/profile/runtime/build-one/bin/bun", "/profile/runtime/current/bin/bun"] {
            #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                appManaged: true,
                installedRuntimePath: pin,
                stateDirectory: stateDirectory) == nil)
        }
        for pin in ["/opt/bun", "/profile/runtime-other/bin/bun", "/profile/runtime/../../operator/bun", ""] {
            #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                appManaged: true,
                installedRuntimePath: pin,
                stateDirectory: stateDirectory)
                == "Gateway service uses an operator-pinned runtime; update it yourself")
        }
        #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: false,
            installedRuntimePath: "/profile/runtime/build-one/bin/bun",
            stateDirectory: stateDirectory) == "Gateway service is not managed by OpenClaw.app")
        #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: true,
            installedRuntimePath: nil,
            stateDirectory: stateDirectory) == "Gateway service runtime could not be inspected")
    }

    @Test func `installed service ownership outranks a retained resume command`() {
        let state = URL(fileURLWithPath: "/profile")
        let service = GatewayLaunchAgentManager.InstalledServiceCLI(
            prefix: ["/operator/bun", "/profile/runtime/build-one/lib/node_modules/openclaw/openclaw.mjs"],
            sqliteLibrary: nil)
        #expect(GatewayHosting.usesSeededGateway(
            hasService: true,
            installedCLI: service,
            hasCurrentSeed: true,
            stateDirectory: state,
            hasRetainedService: true))
        for (prefix, expected) in [
            (["/profile/runtime/build/bin/bun", "/profile/runtime/build/lib/openclaw.mjs"], true),
            (["/profile/tools/node/bin/node", "/profile/lib/node_modules/openclaw/openclaw.mjs"], false),
            (["/profile/runtime/build/bin/bun", "/profile/lib/node_modules/openclaw/openclaw.mjs"], false),
            (service.prefix, true),
        ] {
            let retained = GatewayLaunchAgentManager.InstalledServiceCLI(prefix: prefix, sqliteLibrary: nil)
            #expect(GatewayHosting.usesSeededGateway(
                hasService: false,
                installedCLI: nil,
                hasCurrentSeed: true,
                stateDirectory: state,
                hasRetainedService: true,
                retainedCLI: retained) == expected)
        }
        #expect(!GatewayHosting.usesSeededGateway(
            hasService: false,
            installedCLI: nil,
            hasCurrentSeed: true,
            stateDirectory: state,
            hasRetainedService: true))
        #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: true,
            installedRuntimePath: service.prefix.first,
            stateDirectory: state) == "Gateway service uses an operator-pinned runtime; update it yourself")
    }

    @Test func `existing service CLI keeps its runtime package flags and SQLite selection`() throws {
        let fixtures: [([String], String?)] = [
            (["/old/bin/bun", "/old/lib/node_modules/openclaw/openclaw.mjs"], "/old/lib/libsqlite3.dylib"),
            (["/old/bin/node", "--max-old-space-size=8192", "/old/lib/node_modules/openclaw/dist/index.js"], nil),
        ]
        for (prefix, library) in fixtures {
            let cli = try #require(GatewayLaunchAgentManager.installedServiceCLI(
                snapshot: self.snapshot(prefix + ["gateway", "--port", "29871"], sqliteLibrary: library),
                environmentFile: URL(fileURLWithPath: "/profile/service-env/gateway.env"),
                environmentWrapper: URL(fileURLWithPath: "/profile/service-env/gateway-env-wrapper.sh")))
            #expect(cli.prefix == prefix)
            let environment = GatewayLaunchAgentManager.daemonEnvironment(
                runtime: nil,
                installedCLI: cli,
                environment: ["OPENCLAW_SQLITE_LIBRARY": "/new/lib/libsqlite3.dylib"],
                profile: AppProfile(environment: [:]),
                searchPaths: ["/usr/bin"])
            #expect(environment["OPENCLAW_SQLITE_LIBRARY"] == library)
            #expect(environment["PATH"] == "/old/bin:/usr/bin")
        }
    }

    @Test func `installed service CLI unwraps only the canonical environment wrapper`() {
        let environment = URL(fileURLWithPath: "/profile/service-env/ai.openclaw.proof.env")
        let wrapper = URL(fileURLWithPath: "/profile/service-env/ai.openclaw.proof-env-wrapper.sh")
        let prefix = ["/profile/runtime/build-one/bin/bun", "/profile/runtime/build-one/lib/openclaw.mjs"]
        let command = prefix + ["gateway"]
        for arguments in [
            command,
            [wrapper.path, environment.path] + command,
            ["/bin/sh", wrapper.path, environment.path] + command,
        ] {
            #expect(GatewayLaunchAgentManager.installedServiceCLI(
                snapshot: self.snapshot(arguments),
                environmentFile: environment,
                environmentWrapper: wrapper)?.prefix == prefix)
        }
        for arguments in [
            ["/bin/sh", "/operator/other-env-wrapper.sh", environment.path] + command,
            [wrapper.path, "/operator/other.env"] + command,
            ["/bin/sh", "-c", "exec bun openclaw.mjs gateway"],
            ["/operator/custom-wrapper", "/operator/openclaw.mjs", "gateway"],
            ["/operator/node", "--require", "/operator/custom.js", "/operator/openclaw.mjs", "gateway"],
        ] {
            #expect(GatewayLaunchAgentManager.installedServiceCLI(
                snapshot: self.snapshot(arguments),
                environmentFile: environment,
                environmentWrapper: wrapper) == nil)
        }
    }

    @Test func `app looking symlink to an operator runtime remains operator owned`() throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let stateDirectory = directory.appendingPathComponent("profile")
        let runtimeDirectory = stateDirectory.appendingPathComponent("runtime")
        let operatorDirectory = directory.appendingPathComponent("operator")
        try FileManager.default.createDirectory(at: runtimeDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: operatorDirectory.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try Data().write(to: operatorDirectory.appendingPathComponent("bin/bun"))
        let pin = runtimeDirectory.appendingPathComponent("build-one")
        try FileManager.default.createSymbolicLink(at: pin, withDestinationURL: operatorDirectory)

        #expect(GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: true,
            installedRuntimePath: pin.appendingPathComponent("bin/bun").path,
            stateDirectory: stateDirectory)
            == "Gateway service uses an operator-pinned runtime; update it yourself")
    }
}
