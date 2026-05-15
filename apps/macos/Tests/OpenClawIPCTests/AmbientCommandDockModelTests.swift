import Testing
@testable import OpenClaw

@MainActor
struct AmbientCommandDockModelTests {
    @Test func `typing slash exposes command suggestions`() {
        let model = AmbientCommandDockModel(registry: .default)

        model.inputText = "/ca"

        #expect(model.suggestions.map(\.name) == ["camera", "canvas"])
        #expect(model.thomasState == .focused)
    }

    @Test func `clear resets input and result`() {
        let model = AmbientCommandDockModel(registry: .default)
        model.inputText = "/help"
        model.result = .info("Commands")

        model.clear()

        #expect(model.inputText == "")
        #expect(model.result == .none)
        #expect(model.suggestions.isEmpty)
    }

    @Test func `selecting suggestion writes slash command with trailing space`() {
        let model = AmbientCommandDockModel(registry: .default)
        let canvas = AmbientCommandRegistry.default.command(named: "canvas")!

        model.acceptSuggestion(canvas)

        #expect(model.inputText == "/canvas ")
        #expect(model.suggestions.isEmpty)
    }
}
