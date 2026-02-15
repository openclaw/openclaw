import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct CommandResolverTests {
    private func makeDefaults() -> UserDefaults {
        // Use a unique suite to avoid cross-suite concurrency on UserDefaults.standard.
        UserDefaults(suiteName: "CommandResolverTests.\(UUID().uuidString)")!
    }

    private func makeTempDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeExec(at path: URL) throws {
        try FileManager().createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        FileManager().createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
    }

    @Test func prefersOpenClawBinary() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try self.makeExec(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(subcommand: "gateway", defaults: defaults, configRoot: [:])
        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func fallsBackToNodeAndScript() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        let scriptPath = tmp.appendingPathComponent("bin/openclaw.js")
        try self.makeExec(at: nodePath)
        try "#!/bin/sh\necho v22.0.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        try self.makeExec(at: scriptPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.count >= 3)
        if cmd.count >= 3 {
            #expect(cmd[0] == nodePath.path)
            #expect(cmd[1] == scriptPath.path)
            #expect(cmd[2] == "rpc")
        }
    }

    @Test func fallsBackToPnpm() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.openclawCommand(subcommand: "rpc", defaults: defaults, configRoot: [:])

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "openclaw", "rpc"]))
    }

    @Test func pnpmKeepsExtraArgsAfterSubcommand() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "health",
            extraArgs: ["--json", "--timeout", "5"],
            defaults: defaults,
            configRoot: [:])

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "openclaw", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func preferredPathsStartWithProjectNodeBins() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let first = CommandResolver.preferredPaths().first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func buildsSSHCommandForRemoteMode() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)
        defaults.set("/tmp/id_ed25519", forKey: remoteIdentityKey)
        defaults.set("/srv/openclaw", forKey: remoteProjectRootKey)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "status",
            extraArgs: ["--json"],
            defaults: defaults,
            configRoot: [:])

        #expect(cmd.first == "/usr/bin/ssh")
        if let marker = cmd.firstIndex(of: "--") {
            #expect(cmd[marker + 1] == "openclaw@example.com")
        } else {
            #expect(Bool(false))
        }
        #expect(cmd.contains("-i"))
        #expect(cmd.contains("/tmp/id_ed25519"))
        if let script = cmd.last {
            #expect(script.contains("PRJ='/srv/openclaw'"))
            #expect(script.contains("cd \"$PRJ\""))
            #expect(script.contains("openclaw"))
            #expect(script.contains("status"))
            #expect(script.contains("--json"))
            #expect(script.contains("CLI="))
        }
    }

    @Test func rejectsUnsafeSSHTargets() async throws {
        #expect(CommandResolver.parseSSHTarget("-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("host:-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("user@host:2222")?.port == 2222)
    }

    @Test func configRootLocalOverridesRemoteDefaults() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try self.makeExec(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "daemon",
            defaults: defaults,
            configRoot: ["gateway": ["mode": "local"]])

        #expect(cmd.first == openclawPath.path)
        #expect(cmd.count >= 2)
        if cmd.count >= 2 {
            #expect(cmd[1] == "daemon")
        }
    }

    @Test func appManagedPrefersGlobalBinaryOverProjectAndPnpm() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let projectBin = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try self.makeExec(at: projectBin)

        let globalBinDir = tmp.appendingPathComponent("global-bin", isDirectory: true)
        let globalOpenClaw = globalBinDir.appendingPathComponent("openclaw")
        let pnpm = globalBinDir.appendingPathComponent("pnpm")
        try self.makeExec(at: globalOpenClaw)
        try self.makeExec(at: pnpm)

        let resolved = CommandResolver.appManagedOpenclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [
                tmp.appendingPathComponent("node_modules/.bin").path,
                globalBinDir.path,
            ])

        #expect(resolved.source == .globalBinary)
        #expect(resolved.command.first == globalOpenClaw.path)
    }

    @Test func appManagedFallsBackToNodeEntrypointBeforePnpm() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let nodeBinDir = tmp.appendingPathComponent("node-bin", isDirectory: true)
        try FileManager().createDirectory(at: nodeBinDir, withIntermediateDirectories: true)
        let nodePath = nodeBinDir.appendingPathComponent("node")
        try "#!/bin/sh\necho v22.0.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        let entryPath = tmp.appendingPathComponent("dist/index.js")
        try self.makeExec(at: entryPath)

        let resolved = CommandResolver.appManagedOpenclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [nodeBinDir.path])

        #expect(resolved.source == .nodeEntrypoint)
        #expect(resolved.command.count >= 3)
        if resolved.command.count >= 3 {
            #expect(resolved.command[0] == nodePath.path)
            #expect(resolved.command[1] == entryPath.path)
            #expect(resolved.command[2] == "gateway")
        }
    }

    @Test func appManagedUsesPnpmAsLastFallback() async throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)

        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmBinDir = tmp.appendingPathComponent("pnpm-bin", isDirectory: true)
        let pnpmPath = pnpmBinDir.appendingPathComponent("pnpm")
        try self.makeExec(at: pnpmPath)

        let resolved = CommandResolver.appManagedOpenclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [pnpmBinDir.path])

        #expect(resolved.source == .pnpmFallback)
        #expect(resolved.command.prefix(4).elementsEqual([pnpmPath.path, "--silent", "openclaw", "gateway"]))
    }
}
