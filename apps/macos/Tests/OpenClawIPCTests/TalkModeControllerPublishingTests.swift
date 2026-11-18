import Observation
import Synchronization
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct TalkModeControllerPublishingTests {
    @Test func `preview phase and pause updates retain local presentation state`() async throws {
        try await withVoiceOwnerFixture(activate: false) { _, state, _ in
            let controller = state.voiceRuntime.talkController

            controller.updatePhase(.listening)
            controller.setPaused(true)
            #expect(controller.phase == .listening)
            #expect(controller.isPaused)

            controller.updatePhase(.speaking)
            #expect(controller.phase == .speaking)
            #expect(controller.isPaused)
            controller.setPaused(false)
            #expect(!controller.isPaused)
        }
    }

    @Test func `controller publishes smoothed clamped level`() async throws {
        try await withVoiceOwnerFixture(activate: false) { _, state, _ in
            let controller = state.voiceRuntime.talkController

            controller.updateLevel(2)
            let attackLevel = controller.level
            controller.updateLevel(0.2)
            let releaseLevel = controller.level
            controller.updateLevel(-1)

            #expect(attackLevel > 0 && attackLevel <= 1)
            #expect(releaseLevel > 0.2 && releaseLevel < attackLevel)
            #expect(controller.level == 0)
        }
    }

    @Test(arguments: [TalkModePhase.listening, .speaking])
    func `chat control defers meter observation to the glyph`(phase: TalkModePhase) async throws {
        try await withVoiceOwnerFixture(activate: false) { _, state, _ in
            state.talkEnabled = true
            let controller = state.voiceRuntime.talkController
            controller.updatePhase(phase)
            let catalog = MacChatAudioInputCatalog()
            let surfaceInvalidated = Mutex(false)
            let optionalControl = withObservationTracking {
                MacChatSurface.talkControl(
                    usesPrimaryAppRuntime: true,
                    appState: state,
                    talkController: controller,
                    audioInputCatalog: catalog,
                    isGatewayConnected: true)
            } onChange: {
                surfaceInvalidated.withLock { $0 = true }
            }
            let control = try #require(optionalControl)
            let glyphInvalidated = Mutex(false)
            withObservationTracking {
                _ = ChatTalkButtonGlyph(control: control).body
            } onChange: {
                glyphInvalidated.withLock { $0 = true }
            }

            if phase == .speaking {
                controller.updateSpeakingLevel(1)
            } else {
                controller.updateLevel(1)
            }
            #expect(!surfaceInvalidated.withLock { $0 })
            #expect(glyphInvalidated.withLock { $0 })
            #expect(control.resolvedLevel == 0.45)

            controller.setPaused(true)
            #expect(surfaceInvalidated.withLock { $0 })
            #expect(MacChatSurface.talkControl(
                usesPrimaryAppRuntime: false,
                appState: state,
                talkController: controller,
                audioInputCatalog: catalog,
                isGatewayConnected: true) == nil)
        }
    }

    @Test func `controller publishes bounded finals and distinct partial`() async throws {
        try await withVoiceOwnerFixture(activate: false) { _, state, _ in
            let controller = state.voiceRuntime.talkController
            controller.updatePartialTranscript("  speaking now  ")

            #expect(controller.partialTranscript == "speaking now")

            for index in 0..<25 {
                controller.commitTranscript("utterance \(index)")
            }

            #expect(controller.partialTranscript.isEmpty)
            #expect(controller.recentTranscripts.count == 20)
            #expect(controller.recentTranscripts.first == "utterance 5")
            #expect(controller.recentTranscripts.last == "utterance 24")
        }
    }
}
