import Foundation
import Testing
@testable import Clawdbot

@Suite
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
