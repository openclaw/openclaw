import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct ExecHostCwdTests {
    @Test(.execApprovalsStateIsolated, arguments: ["allow", "mutate", "deny", "revoke"])
    @MainActor
    func `prepared script binding survives authenticated native handoff`(mode: String) async throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let state = ExecApprovalsStore.stateDirURL()
        let script = root.appendingPathComponent("approved.sh")
        let marker = root.appendingPathComponent("effect")
        let bytes = Data("printf approved > '\(marker.path)'\n".utf8)
        try bytes.write(to: script)
        let snapshot = ExecApprovalScriptOperand(
            argvIndex: 1, path: script.path,
            sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        try await ExecApprovalsSocketTestSupport.seedPolicy(
            ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(
                security: mode == "deny" ? .deny : .allowlist, ask: .off,
                askFallback: .deny, autoAllowSkills: false)), in: state)
        let socketPath = root.appendingPathComponent("exec.sock").path
        let server = ExecApprovalsSocketServer(
            socketPath: socketPath, token: "test-token", onPrompt: { _ in .deny },
            onExec: { request in
                // Mutation occurs after authenticated socket admission, before native policy work.
                if mode == "mutate" { try? Data("printf changed > '\(marker.path)'\n".utf8).write(to: script) }
                if mode == "revoke" {
                    try? await ExecApprovalsSocketTestSupport.seedPolicy(
                        ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(
                            security: .deny, ask: .off, askFallback: .deny, autoAllowSkills: false)), in: state)
                }
                return await ExecApprovalsStore.withStateDirectory(state) {
                    await ExecHostExecutor.handle(request)
                }
            }, onUnexpectedStop: { _ in })
        do {
            try #require(await server.start())
            let request = ExecHostRequest(
                command: ["/bin/sh", script.path], cwd: root.path, timeoutMs: 2000,
                agentId: "main", approvalDecision: .allowOnce,
                policySnapshot: OpenClawSystemRunApprovalPolicySnapshot(
                    security: .allowlist, ask: .off, askFallback: .deny,
                    autoAllowSkills: false, allowlistRules: []),
                mutableFileOperand: snapshot)
            let requestJson = try String(decoding: JSONEncoder().encode(request), as: UTF8.self)
            let nonce = UUID().uuidString
            let ts = Int(Date().timeIntervalSince1970 * 1000)
            let digest = HMAC<SHA256>.authenticationCode(
                for: Data("\(nonce):\(ts):\(requestJson)".utf8),
                using: SymmetricKey(data: Data("test-token".utf8)))
            let response = try await ExecApprovalsSocketTestSupport.roundTrip(
                socketPath: socketPath,
                message: ExecHostSocketRequest(
                    type: "exec",
                    id: nonce,
                    nonce: nonce,
                    ts: ts,
                    hmac: digest.map { String(format: "%02x", $0) }.joined(),
                    requestJson: requestJson),
                response: ExecHostResponse.self, timeoutMs: 10000)
            #expect(response.ok == (mode == "allow"))
            #expect(FileManager.default.fileExists(atPath: marker.path) == (mode == "allow"))
            if mode == "allow" { #expect(try String(contentsOf: marker, encoding: .utf8) == "approved") }
            if mode == "mutate" { #expect(response.error?.message.contains("script operand changed") == true) }
        } catch {
            await server.stop().value
            throw error
        }
        await server.stop().value
    }

    @Test(.execApprovalsStateIsolated, arguments: ["/tmp", "/private/tmp"])
    func `native full execution uses the physical temporary directory`(cwd: String) async throws {
        try await ExecApprovalsSocketTestSupport.seedPolicy(
            ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(security: .full, ask: .off)),
            in: ExecApprovalsStore.stateDirURL())
        let response = await ExecHostExecutor.handle(ExecHostRequest(
            command: ["/bin/pwd", "-P"],
            cwd: cwd,
            timeoutMs: 2000))
        #expect(response.ok)
        #expect(response.payload?.success == true)
        #expect(response.payload?.stdout == "/private/tmp\n")

        let cwdSnapshot = try #require(ExecCommandResolution.captureApprovalCwdSnapshot(cwd))
        #expect(cwdSnapshot.path == "/private/tmp")
        #expect(ExecCommandResolution.revalidateApprovalCwdSnapshot(cwdSnapshot))
        let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: ["/bin/pwd", "-P"], cwd: cwd, env: nil)
        let resolution = try #require(ExecCommandResolution.resolve(
            command: ["/bin/pwd", "-P"], cwd: cwdSnapshot.path, env: nil))
        let pattern = try #require(patterns.first)
        #expect(ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: pattern.pattern, argPattern: pattern.argPattern)],
            resolution: resolution) != nil)
    }

    @Test(.execApprovalsStateIsolated) func `native missing cwd reports a directory error without requesting approval`() async {
        let cwd = "/tmp/openclaw-missing-cwd-\(UUID().uuidString)"
        let response = await ExecHostExecutor.handle(ExecHostRequest(
            command: ["/bin/pwd"], cwd: cwd, timeoutMs: 2000))
        #expect(!response.ok)
        #expect(response.error?.reason == "cwd-unavailable")
        #expect(response.error?.message == "Working directory does not exist, is inaccessible, or is not a directory.")
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(cwd) == nil)
    }

    @Test func `cwd snapshot refuses files symlink loops and inaccessible paths`() throws {
        let root = temporaryDirectoryForTests().appendingPathComponent("openclaw-cwd-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("file")
        try Data().write(to: file)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(file.path) == nil)
        let loop = root.appendingPathComponent("loop")
        try FileManager.default.createSymbolicLink(atPath: loop.path, withDestinationPath: loop.path)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(loop.path) == nil)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot("/tmp\0/ignored") == nil)
        let inaccessible = root.appendingPathComponent("locked")
        let child = inaccessible.appendingPathComponent("child")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: inaccessible.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: inaccessible.path) }
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(child.path) == nil)
    }
}
