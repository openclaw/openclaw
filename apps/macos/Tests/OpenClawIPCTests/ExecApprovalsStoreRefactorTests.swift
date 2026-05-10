import Foundation
import SQLite3
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            try await body(stateDir)
        }
    }

    @Test
    func `ensure state stores approvals in sqlite without json sidecar`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = ExecApprovalsStore.ensureState()
            let firstSnapshot = ExecApprovalsStore.readSnapshot()

            _ = ExecApprovalsStore.ensureState()
            let secondSnapshot = ExecApprovalsStore.readSnapshot()

            #expect(firstSnapshot.hash == secondSnapshot.hash)
            #expect(firstSnapshot.path.contains("openclaw.sqlite#kv/exec.approvals/current"))
            #expect(FileManager().fileExists(atPath: ExecApprovalsStore.databaseURL().path))
            #expect(!FileManager().fileExists(atPath: stateDir.appendingPathComponent("exec-approvals.json").path))
            let storedRaw = try Self.readStoredApprovalsRaw()
            #expect(storedRaw?.contains("\"version\" : 1") == true)
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
    func `ensure state hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureState()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func readStoredApprovalsRaw() throws -> String? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(ExecApprovalsStore.databaseURL().path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK
        else {
            defer { sqlite3_close(db) }
            throw NSError(domain: "ExecApprovalsStoreRefactorTests", code: 1)
        }
        defer { sqlite3_close(db) }

        let sql = "SELECT value_json FROM kv WHERE scope = 'exec.approvals' AND key = 'current'"
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            defer { sqlite3_finalize(statement) }
            throw NSError(domain: "ExecApprovalsStoreRefactorTests", code: 2)
        }
        defer { sqlite3_finalize(statement) }

        guard sqlite3_step(statement) == SQLITE_ROW, let rawText = sqlite3_column_text(statement, 0) else {
            return nil
        }
        let valueJSON = String(cString: UnsafeRawPointer(rawText).assumingMemoryBound(to: CChar.self))
        return try JSONDecoder().decode(String.self, from: Data(valueJSON.utf8))
    }
}
