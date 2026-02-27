import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    @Test
    func ensureFileSkipsRewriteWhenUnchanged() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
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
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
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
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo", lastUsedAt: nil, lastUsedCommand: nil, lastResolvedPath: " /usr/bin/echo "),
                ])
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main")
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
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
