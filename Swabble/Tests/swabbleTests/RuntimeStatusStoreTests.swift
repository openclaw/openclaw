import Foundation
import Testing
@testable import Swabble

@Test
func runtimeStatusStorePersistsSnapshotToDisk() async throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".runtime-status.json")
    defer { try? FileManager.default.removeItem(at: url) }

    var cfg = SwabbleConfig()
    cfg.wake.enabled = true
    cfg.wake.word = "clawd"
    cfg.logging.level = "debug"
    cfg.logging.format = "json"
    cfg.logging.redactPii = true

    let store = RuntimeStatusStore(fileURL: url)
    let startedAt = Date(timeIntervalSince1970: 10)
    let wakeAt = Date(timeIntervalSince1970: 20)
    let transcriptAt = Date(timeIntervalSince1970: 30)

    await store.bootstrap(config: cfg, currentAudioDevice: "index 2", at: startedAt)
    await store.noteWakeEvent(at: wakeAt)
    await store.noteTranscriptEvent(at: transcriptAt)

    let snapshot = try #require(await store.current())
    #expect(snapshot.wakeEnabled)
    #expect(snapshot.wakeWord == "clawd")
    #expect(snapshot.currentAudioDevice == "index 2")
    #expect(snapshot.loggingLevel == "debug")
    #expect(snapshot.loggingFormat == "json")
    #expect(snapshot.loggingRedactPii)
    #expect(snapshot.lastWakeEventAt == wakeAt)
    #expect(snapshot.lastTranscriptAt == transcriptAt)
    #expect(snapshot.updatedAt == transcriptAt)

    let reloaded = RuntimeStatusStore(fileURL: url)
    let persisted = try #require(await reloaded.current())
    #expect(persisted == snapshot)
}

@Test
func describeAudioDeviceUsesNameThenIndexThenDefault() {
    var cfg = SwabbleConfig()

    cfg.audio.deviceName = "Built-in Microphone"
    cfg.audio.deviceIndex = 2
    #expect(describeAudioDevice(from: cfg) == "Built-in Microphone")

    cfg.audio.deviceName = "  "
    #expect(describeAudioDevice(from: cfg) == "index 2")

    cfg.audio.deviceIndex = -1
    #expect(describeAudioDevice(from: cfg) == "default")
}
