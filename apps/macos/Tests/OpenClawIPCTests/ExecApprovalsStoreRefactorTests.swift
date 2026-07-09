import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private var realTemporaryDirectory: URL {
        let path = FileManager().temporaryDirectory.path
        if path.hasPrefix("/var/") {
            return URL(fileURLWithPath: "/private\(path)", isDirectory: true)
        }
        return FileManager().temporaryDirectory.resolvingSymlinksInPath()
    }

    private func withLockedEnv(
        _ values: [String: String?],
        _ body: () async throws -> Void) async throws
    {
        func restoreEnv(_ values: [String: String?]) {
            for (key, value) in values {
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }
        }

        await TestIsolationLock.shared.acquire()
        var previousEnv: [String: String?] = [:]
        for (key, value) in values {
            previousEnv[key] = getenv(key).map { String(cString: $0) }
            if let value {
                setenv(key, value, 1)
            } else {
                unsetenv(key)
            }
        }

        do {
            try await body()
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
        } catch {
            restoreEnv(previousEnv)
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try Self.seedCurrentApprovalsFile(in: stateDir)

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(stateDir)
        }
    }

    private func withTempHomeAndStateDir(
        _ body: @escaping @Sendable (URL, URL) async throws -> Void) async throws
    {
        let root = self.realTemporaryDirectory
            .appendingPathComponent("openclaw-home-state-\(UUID().uuidString)", isDirectory: true)
        let home = root.appendingPathComponent("home", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try await self.withLockedEnv([
            "OPENCLAW_HOME": home.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            try await body(home, stateDir)
        }
    }

    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        try await self.withTempStateDir { _ in
            _ = ExecApprovalsStore.ensureFile()
            let url = ExecApprovalsStore.fileURL()
            let firstIdentity = try Self.fileIdentity(at: url)

            _ = ExecApprovalsStore.ensureFile()
            let secondIdentity = try Self.fileIdentity(at: url)

            #expect(firstIdentity == secondIdentity)
        }
    }

    @Test
    func `ensure file migrates default approvals into custom state dir`() async throws {
        try await self.withTempHomeAndStateDir { home, stateDir in
            let legacyDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            try FileManager().createDirectory(
                at: legacyDir,
                withIntermediateDirectories: true)
            let legacySocket = legacyDir.appendingPathComponent("exec-approvals.sock").path
            let legacyFile = legacyDir.appendingPathComponent("exec-approvals.json")
            let legacyJson = """
            {
              "version": 1,
              "socket": {
                "path": "\(legacySocket)",
                "token": "legacy-token"
              },
              "defaults": {
                "security": "deny",
                "ask": "always"
              },
              "agents": {
                "main": {
                  "allowlist": [{ "pattern": "git status" }]
                }
              }
            }
            """
            try Data(legacyJson.utf8).write(to: legacyFile)

            let file = ExecApprovalsStore.ensureFile()
            let targetURL = ExecApprovalsStore.fileURL()

            #expect(targetURL.path == stateDir.appendingPathComponent("exec-approvals.json").path)
            #expect(FileManager().fileExists(atPath: targetURL.path))
            #expect(file.socket?.path == stateDir.appendingPathComponent("exec-approvals.sock").path)
            #expect(file.socket?.token == "legacy-token")
            #expect(file.defaults?.security == .deny)
            #expect(file.defaults?.ask == .always)
            #expect(file.agents?["main"]?.allowlist?.map(\.pattern) == ["git status"])
            #expect(!FileManager().fileExists(atPath: legacyFile.path))
            #expect(FileManager().fileExists(atPath: "\(legacyFile.path).migrated"))
        }
    }

    @Test
    func `update allowlist accepts basename pattern`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["echo", "/bin/echo"])
        }
    }

    @Test
    func `update allowlist migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(
                        pattern: "echo",
                        lastUsedAt: nil,
                        lastUsedCommand: nil,
                        lastResolvedPath: " /usr/bin/echo "),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `native writes wait for the shared sidecar lock`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            let payload = try JSONSerialization.data(withJSONObject: [
                "pid": Int(getpid()),
                "createdAt": ISO8601DateFormatter().string(from: Date()),
            ])
            try payload.write(to: lockURL)
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(100)) {
                try? FileManager().removeItem(at: lockURL)
            }

            let startedAt = Date()
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [ExecAllowlistEntry(pattern: "/bin/echo")])

            #expect(Date().timeIntervalSince(startedAt) >= 0.075)
            #expect(rejected.isEmpty)
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/bin/echo"])
        }
    }

    @Test
    func `native writer reclaims lock from reused pid`() async throws {
        try await self.withTempStateDir { stateDir in
            let lockURL = stateDir.appendingPathComponent("exec-approvals.json.lock")
            let payload = try JSONSerialization.data(withJSONObject: [
                "pid": Int(getpid()),
                "createdAt": ISO8601DateFormatter().string(from: Date()),
                "starttime": 0,
            ])
            try payload.write(to: lockURL)

            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [ExecAllowlistEntry(pattern: "/bin/echo")])

            #expect(rejected.isEmpty)
            #expect(!FileManager().fileExists(atPath: lockURL.path))
            #expect(ExecApprovalsStore.resolve(agentId: "main").allowlist.map(\.pattern) == ["/bin/echo"])
        }
    }

    @Test
    func `conditional save cannot restore revoked approvals`() async throws {
        try await self.withTempStateDir { _ in
            ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .allowlist
                entry.allowlist = [ExecAllowlistEntry(pattern: "/bin/echo")]
            }
            let stale = ExecApprovalsStore.readSnapshot()

            ExecApprovalsStore.updateAgentSettings(agentId: "main") { entry in
                entry.security = .deny
                entry.allowlist = []
            }

            let result = ExecApprovalsStore.saveFile(stale.file, ifBaseHash: stale.hash)
            if case .conflict = result {
                // Expected: the revocation changed the hash before the stale save.
            } else {
                Issue.record("expected stale conditional save to conflict")
            }
            let current = ExecApprovalsStore.resolve(agentId: "main")
            #expect(current.agent.security == .deny)
            #expect(current.allowlist.isEmpty)
        }
    }

    @Test
    func `ensure file hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func fileIdentity(at url: URL) throws -> Int {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let identifier = (attributes[.systemFileNumber] as? NSNumber)?.intValue else {
            struct MissingIdentifierError: Error {}
            throw MissingIdentifierError()
        }
        return identifier
    }

    private static func seedCurrentApprovalsFile(in stateDir: URL) throws {
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let file = ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: stateDir.appendingPathComponent("exec-approvals.sock").path,
                token: "test-token"),
            defaults: nil,
            agents: [:])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(file)
            .write(to: stateDir.appendingPathComponent("exec-approvals.json"))
    }
}
