import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct AmbientCommandDockViewSmokeTests {
    @Test func `command dock view builds body`() {
        let model = AmbientCommandDockModel(registry: .default)
        let view = AmbientCommandDockView(model: model, onDismiss: {})

        _ = view.body
    }

    @Test func `suggestion row builds body`() {
        let spec = AmbientCommandRegistry.default.command(named: "canvas")!
        let view = AmbientCommandSuggestionRow(spec: spec, isSelected: true)

        _ = view.body
    }
}
