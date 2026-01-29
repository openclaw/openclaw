import Foundation
import Testing
@testable import DNA

@Suite(.serialized)
struct DNAConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("dna-config-\(UUID().uuidString)")
            .appendingPathComponent("dna.json")
            .path

        await TestIsolation.withEnvValues(["DNA_CONFIG_PATH": override]) {
            #expect(DNAConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("dna-config-\(UUID().uuidString)")
            .appendingPathComponent("dna.json")
            .path

        await TestIsolation.withEnvValues(["DNA_CONFIG_PATH": override]) {
            DNAConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(DNAConfigFile.remoteGatewayPort() == 19999)
            #expect(DNAConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(DNAConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(DNAConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() async {
        let override = FileManager().temporaryDirectory
            .appendingPathComponent("dna-config-\(UUID().uuidString)")
            .appendingPathComponent("dna.json")
            .path

        await TestIsolation.withEnvValues(["DNA_CONFIG_PATH": override]) {
            DNAConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            DNAConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = DNAConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("dna-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "DNA_CONFIG_PATH": nil,
            "DNA_STATE_DIR": dir,
        ]) {
            #expect(DNAConfigFile.stateDirURL().path == dir)
            #expect(DNAConfigFile.url().path == "\(dir)/dna.json")
        }
    }
}
