import Foundation
import OpenClawKit
import OpenClawNativeState
import Testing
@testable import OpenClaw

struct ExecApprovalsStoreRefactorTests {
    @Test func `policy resolution applies agent then wildcard then defaults`() {
        let file = ExecApprovalsFile(
            version: 1,
            defaults: ExecApprovalsDefaults(security: .allowlist, ask: .off, askFallback: .deny),
            agents: [
                "*": ExecApprovalsAgent(ask: .onMiss, autoAllowSkills: true, allowlist: [
                    ExecAllowlistEntry(id: "wildcard", pattern: "/usr/bin/printf"),
                ]),
                "main": ExecApprovalsAgent(security: .deny, allowlist: [
                    ExecAllowlistEntry(id: "main", pattern: "/bin/echo", argPattern: " ^safe$ "),
                ]),
            ])
        let resolved = ExecApprovalsStore.resolveFromFile(
            file, agentId: "main", socket: ("/tmp/exec-approvals-unused.sock", ""))
        #expect(resolved.agent.security == .deny)
        #expect(resolved.agent.ask == .onMiss)
        #expect(resolved.agent.askFallback == .deny)
        #expect(resolved.agent.autoAllowSkills)
        #expect(resolved.allowlist.map(\.id) == ["wildcard", "main"])
        #expect(resolved.allowlist.last?.argPattern == " ^safe$ ")
        #expect(resolved.file == file)
    }

    @Test func `omitted policy fields match TypeScript defaults`() {
        let resolved = ExecApprovalsStore.resolveDefaults(from: ExecApprovalsFile(version: 1))
        #expect(resolved.security == .full)
        #expect(resolved.ask == .off)
        #expect(resolved.askFallback == .deny)
        #expect(!resolved.autoAllowSkills)
    }

    @Test func `allowlist match key separates embedded nul boundaries`() {
        let nulInPattern = ExecAllowlistEntry(pattern: "/usr/bin/rg\0safe", argPattern: "value")
        let nulInArgPattern = ExecAllowlistEntry(pattern: "/usr/bin/rg", argPattern: "safe\0value")
        #expect(
            ExecApprovalsStore.allowlistEntryMatchKey(nulInPattern) !=
                ExecApprovalsStore.allowlistEntryMatchKey(nulInArgPattern))
    }

    @Test func `local socket credentials expand tilde without changing stored material`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = try OpenClawClientCredentialStore(rootURL: root)
        _ = try owner.createSocketCredentials(.init(
            path: "~/custom/exec-approvals.sock", token: "test-token", updatedAtMs: 1))
        owner.close()
        try await ExecApprovalsStore.withStateDirectory(root) {
            let credentials = try ExecApprovalsStore.localSocketCredentials()
            #expect(!credentials.socketPath.hasPrefix("~"))
            #expect(credentials.socketPath.hasSuffix("/custom/exec-approvals.sock"))
            #expect(credentials.token == "test-token")
            let stored = try DeviceCredentialAccess.execute(
                root: root,
                operation: ClientCredentialOperation(kind: .socketRead)).socket
            #expect(stored?.path == "~/custom/exec-approvals.sock")
            #expect(stored?.token == credentials.token)
        }
    }
}
