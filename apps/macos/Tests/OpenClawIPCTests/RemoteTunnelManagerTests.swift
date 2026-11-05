import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.testWaitLimit)
struct RemoteTunnelManagerTests {
    @Test func `tunnel opened without the sandbox forward is replaced once the port is free`() async {
        let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        // Compile the real manager against a tunnel double: its reuse decision runs without SSH,
        // the PortGuardian ledger, or operator state.
        let result = await ShellExecutor.runDetailed(
            command: ["/bin/bash", tests.appendingPathComponent("Fixtures/RemoteTunnelManager/run.sh").path],
            cwd: nil,
            env: ProcessInfo.processInfo.environment,
            timeout: 60)
        #expect(result.success, "\(result.stdout)\n\(result.stderr)\n\(result.errorMessage ?? "")")
    }

    @Test func `shutdown rejects new tunnel work even after a reusable stop`() async {
        let manager = RemoteTunnelManager()
        await manager.shutdown()
        await manager.stopAll()

        #expect(await manager.controlTunnelRouteIfRunning() == nil)
        await #expect(throws: CancellationError.self) {
            try await manager.ensureControlTunnelRoute()
        }
    }
}
