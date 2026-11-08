import Foundation
import Testing
@testable import OpenClaw

struct PortGuardianDiagnosticsTests {
    @Test(arguments: [nil as UInt16?, 49219]) @MainActor
    func `direct remote diagnostics do not invent a local tunnel listener`(activeTunnelPort: UInt16?) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            try Data(
                #"{"gateway":{"mode":"remote","remote":{"transport":"direct","url":"wss://gateway.example.test"}}}"#
                    .utf8)
                .write(to: URL(fileURLWithPath: configPath))
            let reports = await PortGuardian.shared.diagnose(mode: .remote, activeTunnelPort: activeTunnelPort)
            #expect(reports.isEmpty)
        }
    }

    @Test(arguments: [AppState.RemoteTransport.direct, .ssh], [nil as UInt16?, 49219]) @MainActor
    func `remote diagnostics include the separately hosted local Gateway`(
        transport: AppState.RemoteTransport,
        activeTunnelPort: UInt16?) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": "49217",
        ]) {
            let root: [String: Any] = ["gateway": [
                "mode": "remote",
                "port": 49217,
                "remote": [
                    "transport": transport.rawValue,
                    "url": transport == .ssh ? "ws://127.0.0.1:49218" : "wss://gateway.example.test",
                ],
            ]]
            try JSONSerialization.data(withJSONObject: root).write(to: URL(fileURLWithPath: configPath))
            let reports = await PortGuardian.shared.diagnose(
                mode: .remote,
                activeTunnelPort: activeTunnelPort,
                hostsLocalGateway: true)
            let expectedPorts = transport == .ssh ? [activeTunnelPort == nil ? 49218 : 49219, 49217] : [49217]
            #expect(reports.map(\.port) == expectedPorts)
            #expect(reports.last?.expected == "Gateway websocket (node/tsx)")
        }
    }
}
