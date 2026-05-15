import CoreGraphics
import Testing
@testable import OpenClaw

struct AmbientOverlayModelsTests {
    @Test func `current display resolves from mouse location`() {
        let displays = [
            AmbientOverlayDisplayInfo(id: "left", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            AmbientOverlayDisplayInfo(id: "right", frame: CGRect(x: 100, y: 0, width: 100, height: 100)),
        ]

        let resolved = AmbientOverlayDisplayResolver.targetDisplays(
            displays: displays,
            mouseLocation: CGPoint(x: 125, y: 50),
            scope: .currentDisplay)

        #expect(resolved == [displays[1]])
    }

    @Test func `all displays preserves order`() {
        let displays = [
            AmbientOverlayDisplayInfo(id: "first", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            AmbientOverlayDisplayInfo(id: "second", frame: CGRect(x: 100, y: 0, width: 100, height: 100)),
            AmbientOverlayDisplayInfo(id: "third", frame: CGRect(x: 200, y: 0, width: 100, height: 100)),
        ]

        let resolved = AmbientOverlayDisplayResolver.targetDisplays(
            displays: displays,
            mouseLocation: CGPoint(x: 125, y: 50),
            scope: .allDisplays)

        #expect(resolved == displays)
    }

    @Test func `current display falls back to first display`() {
        let displays = [
            AmbientOverlayDisplayInfo(id: "first", frame: CGRect(x: 0, y: 0, width: 100, height: 100)),
            AmbientOverlayDisplayInfo(id: "second", frame: CGRect(x: 100, y: 0, width: 100, height: 100)),
        ]

        let resolved = AmbientOverlayDisplayResolver.targetDisplays(
            displays: displays,
            mouseLocation: CGPoint(x: 500, y: 500),
            scope: .currentDisplay)

        #expect(resolved == [displays[0]])
    }

    @Test func `invalid raw scope returns nil`() {
        #expect(AmbientOverlayDisplayScope(rawValue: "workspace") == nil)
    }
}
