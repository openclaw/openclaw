import Foundation
import Testing
@testable import OpenClaw

struct PortGuardianIsExpectedTests {
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

    @Test(arguments: [
        (19000, Int32(5252), true),
        (18789, 4242, true),
        (18789, 5252, false),
        (18000, 4242, false),
    ])
    func `remote mode preserves tunnel port and exact managed local listener`(
        port: Int,
        pid: Int32,
        expected: Bool)
    {
        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /tmp/service/dist/index.js gateway",
            port: port,
            mode: .remote,
            tunnelPort: 19000,
            localGatewayPort: 18789,
            pid: pid,
            managedGatewayPID: 4242) == expected)
    }

    @Test func `local mode preserves launchd node dist gateway command`() {
        let fullCommand = """
        /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js gateway --port 18789 --bind loopback
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode preserves git checkout node dist gateway command`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects similarly named node project`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node /tmp/openclaw-tools/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode preserves exact launchd pid from renamed checkout`() {
        let fullCommand = """
        /usr/local/bin/node /Users/dev/Projects/openclaw-codex-coexistence-live/dist/index.js gateway --port 18789
        """

        #expect(PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local,
            pid: 4242,
            managedGatewayPID: 4242))
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: fullCommand,
            port: 18789,
            mode: .local,
            pid: 4242))
    }

    @Test func `local mode rejects stale launchd pid after listener replacement`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/openclaw-tools/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local,
            pid: 5252,
            managedGatewayPID: 4242))
    }

    @Test func `local mode rejects unmanaged listener when launchd pid is absent`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/tmp/service/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local,
            pid: 5252,
            managedGatewayPID: nil))
    }

    @Test func `local mode rejects gateway appearing after another node argument`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/usr/local/bin/node --inspect /tmp/openclaw/dist/index.js gateway --port 18789",
            port: 18789,
            mode: .local))
    }

    @Test func `local mode rejects node dist entrypoint without gateway subcommand`() {
        #expect(!PortGuardian._testIsExpected(
            command: "node",
            fullCommand: "/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/openclaw/dist/index.js doctor",
            port: 18789,
            mode: .local))
    }
}
