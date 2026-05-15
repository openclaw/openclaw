import CoreGraphics
import Testing
@testable import OpenClaw

struct AmbientOverlayDisplayControllerTests {
    @Test func `workspace panel renders above ambient decoration`() {
        #expect(AmbientOverlayDisplayController.workspaceWindowLevel.rawValue
            > AmbientOverlayDisplayController.ambientWindowLevel.rawValue)
    }

    @Test func `command dock frame leaves room for floating Thomas orb`() {
        let display = AmbientOverlayDisplayController.DisplaySnapshot(
            info: AmbientOverlayDisplayInfo(id: "main", frame: CGRect(x: 0, y: 0, width: 1200, height: 800)),
            visibleFrame: CGRect(x: 0, y: 24, width: 1200, height: 740))

        let frame = AmbientOverlayDisplayController.commandDockFrame(for: display)

        #expect(frame.width == 868)
        #expect(frame.height == 264)
        #expect(frame.midX == display.visibleFrame.midX)
        #expect(frame.minY == display.visibleFrame.minY + 28)
    }

    @Test func `current display plan targets mouse display for ambient and workspace`() {
        let displays = [
            AmbientOverlayDisplayController.DisplaySnapshot(
                info: AmbientOverlayDisplayInfo(id: "left", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
                visibleFrame: CGRect(x: 0, y: 10, width: 100, height: 90)),
            AmbientOverlayDisplayController.DisplaySnapshot(
                info: AmbientOverlayDisplayInfo(id: "right", frame: CGRect(x: 100, y: 0, width: 100, height: 100)),
                visibleFrame: CGRect(x: 100, y: 10, width: 100, height: 90)),
        ]

        let plan = AmbientOverlayDisplayController.displayPlan(
            displays: displays,
            mouseLocation: CGPoint(x: 125, y: 50),
            scope: .currentDisplay)

        #expect(plan.ambientDisplays.map(\.id) == ["right"])
        #expect(plan.workspaceDisplay?.id == "right")
    }

    @Test func `all displays plan targets every ambient display but workspace stays current`() {
        let displays = [
            AmbientOverlayDisplayController.DisplaySnapshot(
                info: AmbientOverlayDisplayInfo(id: "left", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
                visibleFrame: CGRect(x: 0, y: 10, width: 100, height: 90)),
            AmbientOverlayDisplayController.DisplaySnapshot(
                info: AmbientOverlayDisplayInfo(id: "right", frame: CGRect(x: 100, y: 0, width: 100, height: 100)),
                visibleFrame: CGRect(x: 100, y: 10, width: 100, height: 90)),
        ]

        let plan = AmbientOverlayDisplayController.displayPlan(
            displays: displays,
            mouseLocation: CGPoint(x: 125, y: 50),
            scope: .allDisplays)

        #expect(plan.ambientDisplays.map(\.id) == ["left", "right"])
        #expect(plan.workspaceDisplay?.id == "right")
    }
}
