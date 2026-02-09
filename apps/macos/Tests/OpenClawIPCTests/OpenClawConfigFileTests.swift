import Foundation
import Testing
@testable import EasyHub

@Suite(.serialized)
struct EasyHubConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("EasyHub-config-\(UUID().uuidString)")
            .appendingPathComponent("easyhub.json")
            .path

        await TestIsolation.withEnvValues(["EASYHUB_CONFIG_PATH": override]) {
            #expect(EasyHubConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("EasyHub-config-\(UUID().uuidString)")
            .appendingPathComponent("easyhub.json")
            .path

        await TestIsolation.withEnvValues(["EASYHUB_CONFIG_PATH": override]) {
            EasyHubConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(EasyHubConfigFile.remoteGatewayPort() == 19999)
            #expect(EasyHubConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(EasyHubConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(EasyHubConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("EasyHub-config-\(UUID().uuidString)")
            .appendingPathComponent("easyhub.json")
            .path

        await TestIsolation.withEnvValues(["EASYHUB_CONFIG_PATH": override]) {
            EasyHubConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            EasyHubConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = EasyHubConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("EasyHub-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "EASYHUB_CONFIG_PATH": nil,
            "EASYHUB_STATE_DIR": dir,
        ]) {
            #expect(EasyHubConfigFile.stateDirURL().path == dir)
            #expect(EasyHubConfigFile.url().path == "\(dir)/easyhub.json")
        }
    }
}
