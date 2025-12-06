import Foundation
import Testing
@testable import Swabble

@Test
func configRoundTrip() throws {
    var cfg = SwabbleConfig()
    cfg.wake.word = "robot"
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
    defer { try? FileManager.default.removeItem(at: url) }

    try ConfigLoader.save(cfg, at: url)
    let loaded = try ConfigLoader.load(at: url)
    #expect(loaded.wake.word == "robot")
    #expect(loaded.hook.prefix.contains("Voice swabble"))
}

@Test
func configMissingThrows() {
    #expect(throws: ConfigError.missingConfig) {
        _ = try ConfigLoader.load(at: FileManager.default.temporaryDirectory.appendingPathComponent("nope.json"))
    }
}
