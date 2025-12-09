import Darwin
import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized) struct CommandResolverTests {
    private func makeTempDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeExec(at path: URL) throws {
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
    }

    @Test func prefersClawdisBinary() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let clawdisPath = tmp.appendingPathComponent("node_modules/.bin/clawdis")
        try self.makeExec(at: clawdisPath)

        let cmd = CommandResolver.clawdisCommand(subcommand: "relay")
        #expect(cmd.prefix(2).elementsEqual([clawdisPath.path, "relay"]))
    }

    @Test func fallsBackToNodeAndScript() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let nodePath = tmp.appendingPathComponent("node_modules/.bin/node")
        let scriptPath = tmp.appendingPathComponent("bin/clawdis.js")
        try self.makeExec(at: nodePath)
        try "#!/bin/sh\necho v22.0.0\n".write(to: nodePath, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodePath.path)
        try self.makeExec(at: scriptPath)

        let cmd = CommandResolver.clawdisCommand(subcommand: "rpc")

        #expect(cmd.count >= 3)
        #expect(cmd[0] == nodePath.path)
        #expect(cmd[1] == scriptPath.path)
        #expect(cmd[2] == "rpc")
    }

    @Test func fallsBackToPnpm() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.clawdisCommand(subcommand: "rpc")

        #expect(cmd.prefix(4).elementsEqual([pnpmPath.path, "--silent", "clawdis", "rpc"]))
    }

    @Test func pnpmKeepsExtraArgsAfterSubcommand() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let pnpmPath = tmp.appendingPathComponent("node_modules/.bin/pnpm")
        try self.makeExec(at: pnpmPath)

        let cmd = CommandResolver.clawdisCommand(subcommand: "health", extraArgs: ["--json", "--timeout", "5"])

        #expect(cmd.prefix(5).elementsEqual([pnpmPath.path, "--silent", "clawdis", "health", "--json"]))
        #expect(cmd.suffix(2).elementsEqual(["--timeout", "5"]))
    }

    @Test func preferredPathsStartWithProjectNodeBins() async throws {
        let tmp = try makeTempDir()
        CommandResolver.setProjectRoot(tmp.path)

        let first = CommandResolver.preferredPaths().first
        #expect(first == tmp.appendingPathComponent("node_modules/.bin").path)
    }

    @Test func buildsSSHCommandForRemoteMode() async throws {
        UserDefaults.standard.set(AppState.ConnectionMode.remote.rawValue, forKey: connectionModeKey)
        UserDefaults.standard.set("[redacted-email]:2222", forKey: remoteTargetKey)
        UserDefaults.standard.set("/tmp/id_ed25519", forKey: remoteIdentityKey)
        UserDefaults.standard.set("/srv/clawdis", forKey: remoteProjectRootKey)
        defer {
            UserDefaults.standard.removeObject(forKey: connectionModeKey)
            UserDefaults.standard.removeObject(forKey: remoteTargetKey)
            UserDefaults.standard.removeObject(forKey: remoteIdentityKey)
            UserDefaults.standard.removeObject(forKey: remoteProjectRootKey)
        }

        let cmd = CommandResolver.clawdisCommand(subcommand: "status", extraArgs: ["--json"])

        #expect(cmd.first == "/usr/bin/ssh")
        #expect(cmd.contains("[redacted-email]"))
        #expect(cmd.contains("-i"))
        #expect(cmd.contains("/tmp/id_ed25519"))
        if let script = cmd.last {
            #expect(script.contains("cd '/srv/clawdis'"))
            #expect(script.contains("clawdis"))
            #expect(script.contains("status"))
            #expect(script.contains("--json"))
            #expect(script.contains("CLI="))
        }
    }
}
