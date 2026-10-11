import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerSelectionTests {
    @Test func `managed inspection preserves the external CLI selected by discovery`() async throws {
        try await self.withCLIInstallations { external, managed, homeDirectory in
            let selected = await CLIInstaller.status()
            #expect(selected == .ready(location: external.path, version: self.fixtureVersion))

            // Startup performs discovery followed by managed inspection before deciding ownership.
            let inspected = await CLIInstaller.managedStatus(
                usesBundledRuntime: false,
                homeDirectory: homeDirectory)
            #expect(inspected == .ready(location: managed.path, version: self.fixtureVersion))
            #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == external.path)
            #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == self.fixtureVersion)
            #expect(CommandResolver.openclawExecutable() == external.path)
        }
    }

    @Test func `managed inspection does not select a CLI when no selection exists`() async throws {
        try await self.withCLIInstallations { _, managed, homeDirectory in
            AppDefaults.standard.removeObject(forKey: cliValidatedExecutableKey)
            AppDefaults.standard.removeObject(forKey: cliValidatedVersionKey)

            #expect(await CLIInstaller.managedStatus(
                usesBundledRuntime: false,
                homeDirectory: homeDirectory) ==
                .ready(location: managed.path, version: self.fixtureVersion))
            #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == nil)
            #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == nil)
        }
    }

    @Test(arguments: [true, false])
    func `managed update selects its CLI only after successful verification`(_ succeeds: Bool) async throws {
        try await self.withCLIInstallations { external, managed, homeDirectory in
            let targetVersion = succeeds ? self.fixtureVersion : "2099.1.1"
            let serviceAuthority = try GatewayLaunchAgentManager.gatewayServiceAuthority(
                stateDirectory: homeDirectory,
                homeDirectory: homeDirectory)
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: targetVersion,
                restartGateway: false,
                homeDirectory: homeDirectory,
                installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI(
                    prefix: [managed.path],
                    sqliteLibrary: nil,
                    serviceAuthority: serviceAuthority),
                statusHandler: { _ in })

            if succeeds {
                #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: self.fixtureVersion))
                #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == managed.path)
                #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == self.fixtureVersion)
                #expect(CommandResolver.openclawExecutable() == managed.path)
            } else {
                guard case .failure = outcome else {
                    Issue.record("An updater success response must not override failed version verification")
                    return
                }
                #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == external.path)
                #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == self.fixtureVersion)
            }
        }
    }

    private func withCLIInstallations(
        _ body: (URL, URL, URL) async throws -> Void) async throws
    {
        let root = try makeTempDirForTests().resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        let external = root.appendingPathComponent("external/bin/openclaw")
        let managed = URL(fileURLWithPath: CLIInstaller.managedExecutableLocation(homeDirectory: root))
        let config = root.appendingPathComponent("openclaw.json")
        try "{}".write(to: config, atomically: false, encoding: .utf8)
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [
                cliValidatedExecutableKey: external.path,
                cliValidatedVersionKey: self.fixtureVersion,
                cliInstallPolicyKey: nil,
                "openclaw.gatewayProjectRootPath": root.path,
            ]) {
                // Keep Foundation's process home fixed and use explicit temporary fixture paths.
                for executable in [external, managed] {
                    try makeExecutableForTests(at: executable)
                    try """
                    #!/bin/sh
                    if [ "$1" = "--version" ]; then
                      printf 'OpenClaw \(self.fixtureVersion)\\n'
                    else
                      printf '{"status":"ok","before":{"version":"2026.8.1"}}\\n'
                    fi

                    """.write(to: executable, atomically: false, encoding: .utf8)
                    let node = executable.deletingLastPathComponent().appendingPathComponent("node")
                    try makeExecutableForTests(at: node)
                    try "#!/bin/sh\nprintf 'v24.16.0\\n'\n".write(to: node, atomically: false, encoding: .utf8)
                }
                try await body(external, managed, root)
            }
    }

    private var fixtureVersion: String {
        GatewayEnvironment.appVersionString() ?? "2026.9.2"
    }
}
