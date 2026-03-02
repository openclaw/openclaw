import Foundation
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
    func ensureFileSkipsRewriteWhenUnchanged() async throws {
        try await self.withTempStateDir { stateDir in
            _ = ExecApprovalsStore.ensureFile()
            let url = ExecApprovalsStore.fileURL()
            let firstWriteDate = try Self.modificationDate(at: url)

            try await Task.sleep(nanoseconds: 1_100_000_000)
            _ = ExecApprovalsStore.ensureFile()
            let secondWriteDate = try Self.modificationDate(at: url)

            #expect(firstWriteDate == secondWriteDate)
        }
    }

    @Test
    func updateAllowlistReportsRejectedBasenamePattern() async throws {
        try await self.withTempStateDir { _ in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ])
            #expect(rejected.count == 1)
            #expect(rejected.first?.reason == .missingPathComponent)
            #expect(rejected.first?.pattern == "echo")

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/bin/echo"])
        }
    }

    @Test
    func updateAllowlistMigratesLegacyPatternFromResolvedPath() async throws {
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
    func ensureFileHardensStateDirectoryPermissions() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile()
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func modificationDate(at url: URL) throws -> Date {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let date = attributes[.modificationDate] as? Date else {
            struct MissingDateError: Error {}
            throw MissingDateError()
        }
        return date
    }
}
