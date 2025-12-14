import Foundation
import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct VoiceWakeOverlayControllerTests {
    @Test func overlayControllerLifecycleWithoutUI() {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(
            source: .wakeWord,
            transcript: "hello",
            attributed: nil,
            forwardEnabled: true,
            isFinal: false)

        #expect(controller.snapshot().token == token)
        #expect(controller.snapshot().isVisible == true)

        controller.updatePartial(token: token, transcript: "hello world")
        #expect(controller.snapshot().text == "hello world")

        controller.updateLevel(token: token, -0.5)
        #expect(controller.model.level == 0)
        controller.updateLevel(token: token, 2.0)
        #expect(controller.model.level == 1)

        controller.dismiss(token: token, reason: .explicit, outcome: .empty)
        #expect(controller.snapshot().isVisible == false)
        #expect(controller.snapshot().token == nil)
    }

    @Test func evaluateTokenDropsMismatchAndNoActive() {
        let active = UUID()
        #expect(VoiceWakeOverlayController.evaluateToken(active: nil, incoming: active) == .dropNoActive)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: UUID()) == .dropMismatch)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: active) == .accept)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: nil) == .accept)
    }
}
