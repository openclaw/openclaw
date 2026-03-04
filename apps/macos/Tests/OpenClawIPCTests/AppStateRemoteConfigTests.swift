import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AppStateRemoteConfigTests {
    @Test
    func updatedRemoteGatewayConfigSetsTrimmedToken() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: [:],
            transport: .ssh,
            remoteUrl: "",
            remoteHost: "gateway.example",
            remoteTarget: "alice@gateway.example",
            remoteIdentity: "/tmp/id_ed25519",
            remoteToken: "  secret-token  ")

        #expect(remote["token"] as? String == "secret-token")
    }

    @Test
    func updatedRemoteGatewayConfigClearsTokenWhenBlank() {
        let remote = AppState._testUpdatedRemoteGatewayConfig(
            current: ["token": "old-token"],
            transport: .direct,
            remoteUrl: "wss://gateway.example",
            remoteHost: nil,
            remoteTarget: "",
            remoteIdentity: "",
            remoteToken: "   ")

        #expect((remote["token"] as? String) == nil)
    }
}
