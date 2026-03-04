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

    @Test
    func syncedGatewayRootPreservesTokenAcrossModeToggleAndClearsOnBlankRemoteToken() {
        let remoteRoot = AppState._testSyncedGatewayRoot(
            currentRoot: [:],
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "wss://gateway.example",
            remoteToken: "  persisted-token  ")
        let remoteGateway = remoteRoot["gateway"] as? [String: Any]
        let remoteConfig = remoteGateway?["remote"] as? [String: Any]
        #expect(remoteGateway?["mode"] as? String == "remote")
        #expect(remoteConfig?["token"] as? String == "persisted-token")

        let localRoot = AppState._testSyncedGatewayRoot(
            currentRoot: remoteRoot,
            connectionMode: .local,
            remoteTransport: .direct,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "",
            remoteToken: "")
        let localGateway = localRoot["gateway"] as? [String: Any]
        let localRemoteConfig = localGateway?["remote"] as? [String: Any]
        #expect(localGateway?["mode"] as? String == "local")
        #expect(localRemoteConfig?["token"] as? String == "persisted-token")

        let clearedRoot = AppState._testSyncedGatewayRoot(
            currentRoot: localRoot,
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteTarget: "",
            remoteIdentity: "",
            remoteUrl: "wss://gateway.example",
            remoteToken: "   ")
        let clearedRemote = (clearedRoot["gateway"] as? [String: Any])?["remote"] as? [String: Any]
        #expect((clearedRemote?["token"] as? String) == nil)
    }
}
