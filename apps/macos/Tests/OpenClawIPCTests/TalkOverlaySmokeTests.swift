import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkOverlaySmokeTests {
    @Test func talkOverlayViewBuildsBody() {
        let controller = TalkOverlayController()
        controller.updatePhase(.listening)
        controller.updatePaused(true)
        controller.updateSeamColor("#336699")

        let view = TalkOverlayView(controller: controller)
        _ = view.body
    }

    @Test func talkOverlayControllerPresentsAndDismisses() async {
        let controller = TalkOverlayController()
        controller.updatePhase(.thinking)
        controller.present()
        controller.updateLevel(0.2)
        #expect(controller.model.level == 0.2)
        controller.dismiss()
        try? await Task.sleep(nanoseconds: 250_000_000)
        #expect(controller.model.isVisible == false)
    }
}
