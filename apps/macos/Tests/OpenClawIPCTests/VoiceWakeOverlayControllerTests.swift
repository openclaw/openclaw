import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct VoiceWakeOverlayControllerTests {
    @Test func `overlay controller lifecycle without UI`() async {
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
        try? await Task.sleep(nanoseconds: 120_000_000)
        controller.updateLevel(token: token, 2.0)
        #expect(controller.model.level == 1)

        controller.dismiss(token: token, reason: .explicit, outcome: .empty)
        #expect(controller.snapshot().isVisible == false)
        #expect(controller.snapshot().token == nil)
    }

    @Test func `evaluate token drops mismatch and no active`() {
        let active = UUID()
        #expect(VoiceWakeOverlayController.evaluateToken(active: nil, incoming: active) == .dropNoActive)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: UUID()) == .dropMismatch)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: active) == .accept)
        #expect(VoiceWakeOverlayController.evaluateToken(active: active, incoming: nil) == .accept)
    }

    @Test func `update level throttles rapid changes`() async {
        let controller = VoiceWakeOverlayController(enableUI: false)
        let token = controller.startSession(
            source: .wakeWord,
            transcript: "level test",
            attributed: nil,
            forwardEnabled: false,
            isFinal: false)

        controller.updateLevel(token: token, 0.25)
        let first = controller.model.level

        controller.updateLevel(token: token, 0.9)
        #expect(controller.model.level == first)

        controller.updateLevel(token: token, 0)
        #expect(controller.model.level == 0)

        try? await Task.sleep(nanoseconds: 120_000_000)
        controller.updateLevel(token: token, 0.9)
        #expect(controller.model.level == 0.9)
    }

    @Test func `overlay controller exercises helpers`() async {
        await VoiceWakeOverlayController.exerciseForTesting()
    }

    @Test func `measuredHeight does not mutate isOverflowing when unchanged`() {
        let controller = VoiceWakeOverlayController(enableUI: false)
        _ = controller.startSession(
            source: .wakeWord,
            transcript: "short",
            attributed: nil,
            forwardEnabled: true,
            isFinal: false)
        // First call sets isOverflowing when it changes.
        let h1 = controller.measuredHeight()
        let overflowAfterFirst = controller.model.isOverflowing
        // Second call with same content must not flip isOverflowing again (no-op guard).
        let h2 = controller.measuredHeight()
        #expect(h1 == h2)
        #expect(controller.model.isOverflowing == overflowAfterFirst)
    }
}
