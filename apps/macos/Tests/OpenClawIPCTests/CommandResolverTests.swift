import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized) struct CommandResolverTests {
    private func makeDefaults() -> UserDefaults {
        // Use a unique suite to avoid cross-suite concurrency on UserDefaults.standard.
        UserDefaults(suiteName: "CommandResolverTests.\(UUID().uuidString)")!
    }

    private func makeLocalDefaults() -> UserDefaults {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.local.rawValue, forKey: connectionModeKey)
        return defaults
    }

    private func makeProjectRootWithPnpm() throws -> (tmp: URL, pnpmPath: URL) {
        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)
        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try makeExecutableForTests(at: pnpmPath)
        return (tmp, pnpmPath)
    }

    @Test func `prefers open claw binary`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(subcommand: "gateway", defaults: defaults, configRoot: [:])
        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `falls back to node and script`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        let scriptPath = tmp.appendingPathComponent("bin/openclaw.js")
        try makeExecutableForTests(at: nodePath)
        try "#!/bin/sh\necho v22.0.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        try makeExecutableForTests(at: scriptPath)

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

    @Test func `prefers open claw binary over pnpm`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        let pnpmPath = binDir.appendingPathComponent("pnpm")
        try makeExecutableForTests(at: openclawPath)
        try makeExecutableForTests(at: pnpmPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "rpc"]))
    }

    @Test func `uses open claw binary without node runtime`() throws {
        let defaults = self.makeLocalDefaults()

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let binDir = tmp.appendingPathComponent("bin")
        let openclawPath = binDir.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: openclawPath)

        let cmd = CommandResolver.openclawCommand(
            subcommand: "gateway",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [binDir.path])

        #expect(cmd.prefix(2).elementsEqual([openclawPath.path, "gateway"]))
    }

    @Test func `falls back to pnpm`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "rpc",
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "openclaw", "rpc"]))
    }

    @Test func `pnpm keeps extra args after subcommand`() throws {
        let defaults = self.makeLocalDefaults()
        let (tmp, pnpmPath) = try self.makeProjectRootWithPnpm()

        let cmd = CommandResolver.openclawCommand(
            subcommand: "health",
            extraArgs: ["--json", "--timeout", "5"],
            defaults: defaults,
            configRoot: [:],
            searchPaths: [tmp.appendingPathComponent("node_modules/.bin").path])

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "openclaw", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func `preferred paths start with project node bins`() throws {
        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let first = CommandResolver.preferredPaths().first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func `builds SSH command for remote mode`() {
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

    @Test func `rejects unsafe SSH targets`() {
        #expect(CommandResolver.parseSSHTarget("-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("host:-oProxyCommand=calc") == nil)
        #expect(CommandResolver.parseSSHTarget("user@host:2222")?.port == 2222)
    }

    @Test func `config root local overrides remote defaults`() throws {
        let defaults = self.makeDefaults()
        defaults.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        defaults.set("openclaw@example.com:2222", forKey: remoteTargetKey)

        let tmp = try makeTempDirForTests()
        CommandResolver.setProjectRoot(tmp.path)

        let openclawPath = tmp.appendingPathComponent("node_modules/.bin/openclaw")
        try makeExecutableForTests(at: openclawPath)

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

    // MARK: - readEtcPaths tests

    @Test func `reads etc paths file`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "/usr/local/bin\n/usr/bin\n/bin\n/usr/sbin\n/sbin\n"
            .write(to: etcPaths, atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    }

    @Test func `reads etc paths d files`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "/usr/bin\n/bin\n".write(to: etcPaths, atomically: true, encoding: .utf8)
        try "/opt/homebrew/bin\n/opt/homebrew/sbin\n"
            .write(to: etcPathsD.appendingPathComponent("Homebrew"), atomically: true, encoding: .utf8)
        try "/Library/TeX/texbin\n"
            .write(to: etcPathsD.appendingPathComponent("TeX"), atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == [
            "/usr/bin", "/bin",
            "/opt/homebrew/bin", "/opt/homebrew/sbin",
            "/Library/TeX/texbin",
        ])
    }

    @Test func `deduplicates etc paths entries`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "/usr/local/bin\n/usr/bin\n".write(to: etcPaths, atomically: true, encoding: .utf8)
        try "/opt/homebrew/bin\n/usr/local/bin\n"
            .write(to: etcPathsD.appendingPathComponent("Homebrew"), atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"])
    }

    @Test func `skips blank and comment lines in etc paths`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "# system paths\n/usr/bin\n\n  \n/bin\n# trailing\n"
            .write(to: etcPaths, atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/usr/bin", "/bin"])
    }

    @Test func `handles missing etc paths gracefully`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("nonexistent-paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "/opt/custom/bin\n"
            .write(to: etcPathsD.appendingPathComponent("custom"), atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/opt/custom/bin"])
    }

    @Test func `handles missing etc paths d gracefully`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("nonexistent-paths-d")

        try "/usr/bin\n".write(to: etcPaths, atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/usr/bin"])
    }

    @Test func `handles both etc paths and etc paths d missing`() throws {
        let tmp = try makeTempDirForTests()
        let result = CommandResolver.readEtcPaths(
            etcPaths: tmp.appendingPathComponent("nope").path,
            etcPathsD: tmp.appendingPathComponent("also-nope").path)
        #expect(result.isEmpty)
    }

    @Test func `etc paths d entries read in sorted order`() throws {
        let tmp = try makeTempDirForTests()
        let etcPaths = tmp.appendingPathComponent("paths")
        let etcPathsD = tmp.appendingPathComponent("paths.d")
        try FileManager().createDirectory(at: etcPathsD, withIntermediateDirectories: true)

        try "".write(to: etcPaths, atomically: true, encoding: .utf8)
        try "/opt/zebra/bin\n"
            .write(to: etcPathsD.appendingPathComponent("zebra"), atomically: true, encoding: .utf8)
        try "/opt/alpha/bin\n"
            .write(to: etcPathsD.appendingPathComponent("alpha"), atomically: true, encoding: .utf8)

        let result = CommandResolver.readEtcPaths(
            etcPaths: etcPaths.path,
            etcPathsD: etcPathsD.path)
        #expect(result == ["/opt/alpha/bin", "/opt/zebra/bin"])
    }
}
