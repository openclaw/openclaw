import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct ConfigStoreTests {
    @Test func `load uses remote in remote mode`() async {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))

        let result = await ConfigStore.load()

        await ConfigStore._testClearOverrides()
        #expect(remoteHit)
        #expect(!localHit)
        #expect(result["remote"] as? Bool == true)
    }

    @Test func `load uses local in local mode`() async {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { false },
            loadLocal: { localHit = true; return ["local": true] },
            loadRemote: { remoteHit = true; return ["remote": true] }))

        let result = await ConfigStore.load()

        await ConfigStore._testClearOverrides()
        #expect(localHit)
        #expect(!remoteHit)
        #expect(result["local"] as? Bool == true)
    }

    @Test func `save routes to remote in remote mode`() async throws {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { true },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))

        try await ConfigStore.save(["remote": true])

        await ConfigStore._testClearOverrides()
        #expect(remoteHit)
        #expect(!localHit)
    }

    @Test func `save routes to local in local mode`() async throws {
        var localHit = false
        var remoteHit = false
        await ConfigStore._testSetOverrides(.init(
            isRemoteMode: { false },
            saveLocal: { _ in localHit = true },
            saveRemote: { _ in remoteHit = true }))

        try await ConfigStore.save(["local": true])

        await ConfigStore._testClearOverrides()
        #expect(localHit)
        #expect(!remoteHit)
    }

    @Test func `local save fallback preserves gateway redacted secrets`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-store-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
            "OPENCLAW_GATEWAY_PORT": "1",
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "real-secret-token",
                    ],
                ],
                "channels": [
                    "discord": [
                        "enabled": true,
                        "dmPolicy": "pairing",
                    ],
                ],
            ])

            await ConfigStore._testSetOverrides(.init(isRemoteMode: { false }))

            try await ConfigStore.save([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "__OPENCLAW_REDACTED__",
                    ],
                ],
                "channels": [
                    "discord": [
                        "enabled": true,
                        "dmPolicy": "open",
                    ],
                ],
            ])

            let root = OpenClawConfigFile.loadDict()
            let auth = ((root["gateway"] as? [String: Any])?["auth"] as? [String: Any]) ?? [:]
            let discord = ((root["channels"] as? [String: Any])?["discord"] as? [String: Any]) ?? [:]
            #expect(auth["token"] as? String == "real-secret-token")
            #expect(discord["dmPolicy"] as? String == "open")

            await ConfigStore._testClearOverrides()
        }
    }
}
