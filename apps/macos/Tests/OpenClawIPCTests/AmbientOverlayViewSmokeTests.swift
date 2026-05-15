import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct AmbientOverlayViewSmokeTests {
    @Test func `ambient overlay view builds body`() {
        let view = AmbientOverlayView(intensity: 0.45)

        _ = view.body
    }

    @Test func `ambient overlay default visual style remains clearly visible`() {
        let style = AmbientOverlayVisualStyle(intensity: AmbientOverlaySettings.defaultIntensity)

        #expect(style.frameOpacity >= 0.32)
        #expect(style.cornerOpacity >= 0.42)
        #expect(style.glowOpacity >= 0.24)
        #expect(style.sweepOpacity >= 0.18)
    }

    @Test func `ambient overlay low intensity keeps a visible outline`() {
        let style = AmbientOverlayVisualStyle(intensity: AmbientOverlaySettings.intensityRange.lowerBound)

        #expect(style.frameOpacity >= 0.2)
        #expect(style.cornerOpacity >= 0.28)
    }

    @Test func `ambient workspace sheet view builds body`() {
        let view = AmbientWorkspaceSheetView {}

        _ = view.body
    }
}
