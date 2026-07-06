import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
private final class GatedClipPlayer: ChatSpeechClipPlaying {
    var playedData: [Data] = []
    var stopCount = 0
    private var pending: CheckedContinuation<Bool, Never>?

    func play(data: Data) async -> Bool {
        self.playedData.append(data)
        return await withCheckedContinuation { continuation in
            self.pending = continuation
        }
    }

    func stop() {
        self.stopCount += 1
        self.resolve(false)
    }

    func resolve(_ finished: Bool) {
        let pending = self.pending
        self.pending = nil
        pending?.resume(returning: finished)
    }
}

@MainActor
private final class RecordingLocalSpeaker: ChatSpeechLocalSpeaking {
    var spokenTexts: [String] = []
    var stopCount = 0

    func speak(text: String) async -> Bool {
        self.spokenTexts.append(text)
        return true
    }

    func stop() {
        self.stopCount += 1
    }
}

@MainActor
private struct SpeechHarness {
    let controller: OpenClawChatSpeechController
    let clipPlayer: GatedClipPlayer
    let localSpeaker: RecordingLocalSpeaker

    init(synthesize: @escaping OpenClawChatSpeechSynthesis) {
        let clipPlayer = GatedClipPlayer()
        let localSpeaker = RecordingLocalSpeaker()
        self.clipPlayer = clipPlayer
        self.localSpeaker = localSpeaker
        self.controller = OpenClawChatSpeechController(
            synthesize: synthesize,
            clipPlayer: clipPlayer,
            localSpeech: localSpeaker)
    }
}

/// Polls until the controller reaches the expected phase; playback hops
/// through an unstructured task, so tests must yield to it.
@MainActor
private func waitForPhase(
    _ controller: OpenClawChatSpeechController,
    _ expected: OpenClawChatSpeechController.Phase) async -> Bool
{
    for _ in 0..<200 {
        if controller.phase == expected { return true }
        await Task.yield()
    }
    return controller.phase == expected
}

@MainActor
@Suite("OpenClawChatSpeechController")
struct ChatSpeechControllerTests {
    @Test func playsGatewayClipAndReturnsToIdle() async {
        let clip = OpenClawChatSpeechClip(data: Data([9, 9, 9]), mimeType: "audio/mpeg")
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Hello there.")
        #expect(harness.controller.phase == .preparing(messageID))
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))
        #expect(harness.clipPlayer.playedData == [Data([9, 9, 9])])

        harness.clipPlayer.resolve(true)
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }

    @Test func fallsBackToLocalSpeechWhenSynthesisFails() async {
        struct SynthesisFailed: Error {}
        let harness = SpeechHarness { _ in throw SynthesisFailed() }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Read me aloud")
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts == ["Read me aloud"])
        #expect(harness.clipPlayer.playedData.isEmpty)
    }

    @Test func fallsBackToLocalSpeechWhenClipIsUnplayable() async {
        let clip = OpenClawChatSpeechClip(data: Data([1]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Broken clip")
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))

        // Unplayable clip resolves false without a user stop.
        harness.clipPlayer.resolve(false)
        #expect(await waitForPhase(harness.controller, .idle))
        #expect(harness.localSpeaker.spokenTexts == ["Broken clip"])
    }

    @Test func toggleWhileActiveStopsWithoutFallback() async {
        let clip = OpenClawChatSpeechClip(data: Data([5]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let messageID = UUID()

        harness.controller.toggle(messageID: messageID, text: "Long reply")
        #expect(await waitForPhase(harness.controller, .speaking(messageID)))

        harness.controller.toggle(messageID: messageID, text: "Long reply")
        #expect(harness.controller.phase == .idle)
        #expect(harness.clipPlayer.stopCount > 0)
        // The interrupted clip resolves false, but the bumped generation must
        // keep the stop from cascading into the on-device voice.
        for _ in 0..<50 { await Task.yield() }
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }

    @Test func startingAnotherMessageSupersedesTheFirst() async {
        let clip = OpenClawChatSpeechClip(data: Data([7]), mimeType: nil)
        let harness = SpeechHarness { _ in clip }
        let first = UUID()
        let second = UUID()

        harness.controller.toggle(messageID: first, text: "First message")
        #expect(await waitForPhase(harness.controller, .speaking(first)))

        harness.controller.toggle(messageID: second, text: "Second message")
        #expect(await waitForPhase(harness.controller, .speaking(second)))
        #expect(harness.controller.isActive(second))
        #expect(!harness.controller.isActive(first))

        harness.clipPlayer.resolve(true)
        #expect(await waitForPhase(harness.controller, .idle))
    }

    @Test func blankTextStaysIdle() async {
        let harness = SpeechHarness { _ in
            OpenClawChatSpeechClip(data: Data([1]), mimeType: nil)
        }

        harness.controller.toggle(messageID: UUID(), text: "   \n  ")
        #expect(harness.controller.phase == .idle)
        for _ in 0..<50 { await Task.yield() }
        #expect(harness.clipPlayer.playedData.isEmpty)
        #expect(harness.localSpeaker.spokenTexts.isEmpty)
    }
}
