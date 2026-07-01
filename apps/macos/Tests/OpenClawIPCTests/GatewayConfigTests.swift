import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite(.serialized)
struct GatewayConfigTests {
    @Test @MainActor func `load gateway config reads state dir config`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-cli-state-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        let configURL = stateDir.appendingPathComponent("openclaw.json")
        try self.writeGatewayConfig(
            to: configURL,
            remoteURL: "ws://state-dir.example:18789",
            token: "state-token")

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let config = loadGatewayConfig()

            #expect(config.mode == "remote")
            #expect(config.remoteUrl == "ws://state-dir.example:18789")
            #expect(config.remoteToken == "state-token")
        }
    }

    @Test @MainActor func `load gateway config prefers explicit config path over state dir`() async throws {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-cli-config-precedence-\(UUID().uuidString)", isDirectory: true)
        let stateDir = dir.appendingPathComponent("state", isDirectory: true)
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: dir) }

        let explicitConfigURL = dir.appendingPathComponent("explicit.json")
        let stateConfigURL = stateDir.appendingPathComponent("openclaw.json")
        try self.writeGatewayConfig(
            to: explicitConfigURL,
            remoteURL: "ws://explicit.example:18789",
            token: "explicit-token")
        try self.writeGatewayConfig(
            to: stateConfigURL,
            remoteURL: "ws://state.example:18789",
            token: "state-token")

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": explicitConfigURL.path,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let config = loadGatewayConfig()

            #expect(config.remoteUrl == "ws://explicit.example:18789")
            #expect(config.remoteToken == "explicit-token")
        }
    }

    private func writeGatewayConfig(to url: URL, remoteURL: String, token: String) throws {
        let root: [String: Any] = [
            "gateway": [
                "mode": "remote",
                "remote": [
                    "url": remoteURL,
                    "token": token,
                ],
            ],
        ]
        try FileManager().createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted])
        try data.write(to: url, options: [.atomic])
    }
}
