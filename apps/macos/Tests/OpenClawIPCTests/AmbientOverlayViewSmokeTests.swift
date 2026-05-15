import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct AmbientOverlayViewSmokeTests {
    @Test func `ambient overlay view builds body`() {
        let view = AmbientOverlayView(intensity: 0.45)

        _ = view.body
    }

    @Test func `ambient workspace sheet view builds body`() {
        let view = AmbientWorkspaceSheetView {}

        _ = view.body
    }
}
