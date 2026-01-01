import Foundation
import Testing
@testable import Clawdis

@Suite
struct ClawdisConfigFileTests {
    @Test
    func configPathRespectsEnvOverride() {
        let override = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdis.json")
            .path

        self.withEnv("CLAWDIS_CONFIG_PATH", value: override) {
            #expect(ClawdisConfigFile.url().path == override)
        }
    }

    @Test
    func stateDirOverrideSetsConfigPath() {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-state-\(UUID().uuidString)", isDirectory: true)
            .path

        self.withEnv("CLAWDIS_CONFIG_PATH", value: nil) {
            self.withEnv("CLAWDIS_STATE_DIR", value: dir) {
                #expect(ClawdisConfigFile.stateDirURL().path == dir)
                #expect(ClawdisConfigFile.url().path == "\(dir)/clawdis.json")
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
