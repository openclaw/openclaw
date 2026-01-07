import Foundation
import Testing
@testable import Clawdbot

@Suite(.serialized)
struct ClawdbotConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        self.withEnv("CLAWDBOT_CONFIG_PATH", value: override) {
            #expect(ClawdbotConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func remoteGatewayPortParsesAndMatchesHost() {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        self.withEnv("CLAWDBOT_CONFIG_PATH", value: override) {
            ClawdbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://bridge.ts.net:19999",
                    ],
                ],
            ])
            #expect(ClawdbotConfigFile.remoteGatewayPort() == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "bridge.ts.net") == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "bridge") == 19999)
            #expect(ClawdbotConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func setRemoteGatewayUrlPreservesScheme() {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        self.withEnv("CLAWDBOT_CONFIG_PATH", value: override) {
            ClawdbotConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            ClawdbotConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = ClawdbotConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-state-\(UUID().uuidString)", isDirectory: true)
            .path

        self.withEnv("CLAWDBOT_CONFIG_PATH", value: nil) {
            self.withEnv("CLAWDBOT_STATE_DIR", value: dir) {
                #expect(ClawdbotConfigFile.stateDirURL().path == dir)
                #expect(ClawdbotConfigFile.url().path == "\(dir)/clawdbot.json")
            }
        }
    }

    private func withEnv(_ key: String, value: String?, _ body: () -> Void) {
        let previous = ProcessInfo.processInfo.environment[key]
        if let value {
            setenv(key, value, 1)
        } else {
            unsetenv(key)
        }
        defer {
            if let previous {
                setenv(key, previous, 1)
            } else {
                unsetenv(key)
            }
        }
        body()
    }
}
