import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppStateRemoteAuthSyncTests {
    @Test
    func appStateLoadsRemoteCredentialsFromConfig() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "url": "wss://gateway.example.ts.net",
                        "token": " remote-token ",
                        "password": " remote-password ",
                    ],
                ],
            ])

            let state = AppState(preview: true)
            #expect(state.remoteToken == "remote-token")
            #expect(state.remotePassword == "remote-password")
        }
    }

    @Test
    func updatedRemoteGatewayConfigWritesRemoteCredentials() {
        let updated = AppState._testUpdatedRemoteGatewayConfig(
            current: [:],
            transport: .direct,
            remoteUrl: "wss://gateway.example.ts.net",
            remoteHost: nil,
            remoteTarget: "",
            remoteIdentity: "",
            remoteToken: " test-token ",
            remotePassword: " test-password ")

        #expect(updated.changed)
        #expect((updated.remote["token"] as? String) == "test-token")
        #expect((updated.remote["password"] as? String) == "test-password")
    }

    @Test
    func updatedRemoteGatewayConfigRemovesEmptyRemoteCredentials() {
        let updated = AppState._testUpdatedRemoteGatewayConfig(
            current: [
                "token": "old-token",
                "password": "old-password",
                "url": "wss://gateway.example.ts.net",
            ],
            transport: .direct,
            remoteUrl: "wss://gateway.example.ts.net",
            remoteHost: nil,
            remoteTarget: "",
            remoteIdentity: "",
            remoteToken: " ",
            remotePassword: "\n")

        #expect(updated.changed)
        #expect(updated.remote["token"] == nil)
        #expect(updated.remote["password"] == nil)
        #expect((updated.remote["url"] as? String) == "wss://gateway.example.ts.net")
    }
}
