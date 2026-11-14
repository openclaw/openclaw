import Foundation
import Testing
@testable import OpenClaw

struct ExecHostFullEnvironmentTests {
    @Test(.execApprovalsStateIsolated)
    func `full native execution forwards requested helper and runtime environment`() async throws {
        try await ExecApprovalsSocketTestSupport.seedPolicy(
            ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(security: .full, ask: .off)),
            in: ExecApprovalsStore.stateDirURL())
        let response = await ExecHostExecutor.handle(ExecHostRequest(
            command: ["/bin/sh", "-c", "printf '%s|%s' \"$SUDO_ASKPASS\" \"$PYTHONPATH\""],
            cwd: "/tmp",
            env: ["SUDO_ASKPASS": "/opt/openclaw-test/askpass", "PYTHONPATH": "/opt/test-modules"],
            timeoutMs: 2000))
        #expect(response.ok)
        #expect(response.payload?.success == true)
        #expect(response.payload?.stdout == "/opt/openclaw-test/askpass|/opt/test-modules")
    }

    @Test(.execApprovalsStateIsolated)
    func `approval environment keeps constrained and forwarded requests filtered`() async throws {
        let cases: [(ExecSecurity, ExecAsk, Bool, Bool)] = [
            (.full, .off, false, true),
            (.full, .always, false, false),
            (.allowlist, .off, false, false),
            (.full, .off, true, false),
        ]
        for (security, ask, forwardedApproval, allowed) in cases {
            try await ExecApprovalsSocketTestSupport.seedPolicy(
                ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(
                    security: security, ask: ask)),
                in: ExecApprovalsStore.stateDirURL())
            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: ["/bin/sh", "-c", "/usr/bin/true"],
                rawCommand: nil,
                cwd: "/tmp",
                envOverrides: [
                    "SUDO_ASKPASS": "/opt/openclaw-test/askpass",
                    "PYTHONPATH": "/opt/test-modules",
                ],
                agentId: nil,
                hasForwardedApproval: forwardedApproval)
            #expect(evaluation.env["SUDO_ASKPASS"] == (allowed ? "/opt/openclaw-test/askpass" : nil))
            #expect(evaluation.env["PYTHONPATH"] == (allowed ? "/opt/test-modules" : nil))
        }
    }
}
