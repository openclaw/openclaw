import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct HoverHUDControllerTests {
    @Test func `hover HUD controller presents and dismisses`() async {
        let controller = HoverHUDController.shared
        controller.resetForTests()
        defer { controller.resetForTests() }
        controller.setSuppressed(false)
        try? await Task.sleep(nanoseconds: 220_000_000)

        controller.statusItemHoverChanged(
            inside: true,
            anchorProvider: { NSRect(x: 10, y: 10, width: 24, height: 24) })
        try? await Task.sleep(nanoseconds: 260_000_000)

        controller.panelHoverChanged(inside: true)
        controller.panelHoverChanged(inside: false)
        controller.statusItemHoverChanged(
            inside: false,
            anchorProvider: { NSRect(x: 10, y: 10, width: 24, height: 24) })
        controller.toggleCompact()
        controller.toggleCompact()
        controller.toggleCharm()
        controller.expandFromCharm()
        controller.togglePinned()
        controller.togglePinned()
        controller.openWidgetFromMenu()
        controller.openExpandedFromStatusItem(anchorProvider: { NSRect(x: 10, y: 10, width: 24, height: 24) })

        controller.dismiss(reason: "test")
        controller.closeWidget()
        controller.setSuppressed(true)
        try? await Task.sleep(nanoseconds: 260_000_000)
    }

    @Test func `charm mode collapses into status item and expands back`() async {
        let controller = HoverHUDController.shared
        controller.resetForTests()
        defer { controller.resetForTests() }
        controller.setSuppressed(false)
        try? await Task.sleep(nanoseconds: 220_000_000)

        controller.openExpandedFromStatusItem(
            anchorProvider: { NSRect(x: 24, y: 24, width: 26, height: 24) })
        try? await Task.sleep(nanoseconds: 80_000_000)
        #expect(controller.model.isVisible == true)
        #expect(controller.model.isCharm == false)

        controller.toggleCharm()
        try? await Task.sleep(nanoseconds: 280_000_000)
        #expect(controller.model.isVisible == false)
        #expect(controller.model.isCharm == true)

        controller.expandFromCharm()
        try? await Task.sleep(nanoseconds: 80_000_000)
        #expect(controller.model.isVisible == true)
        #expect(controller.model.isCharm == false)

        controller.dismiss(reason: "test-charm")
        try? await Task.sleep(nanoseconds: 220_000_000)
    }
}
