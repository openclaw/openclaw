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

    @Test func `submitting command clears input and stores result`() async {
        let model = AmbientCommandDockModel(
            registry: .default,
            actions: AmbientCommandDockActionExecutor(environment: .testing()))
        model.inputText = "/intensity 70"

        await model.submit()

        #expect(model.inputText == "")
        #expect(model.result == .success("Ambient intensity set to 70%"))
        #expect(model.thomasState == .success)
    }

    @Test func `return accepts partial suggestions but submits exact commands`() {
        let model = AmbientCommandDockModel(registry: .default)

        model.inputText = "/ca"
        #expect(model.shouldAcceptSuggestionOnReturn)

        model.inputText = "/canvas"
        #expect(!model.shouldAcceptSuggestionOnReturn)
    }

    @Test func `clear command clears composer without leaving result text`() async {
        let model = AmbientCommandDockModel(
            registry: .default,
            actions: AmbientCommandDockActionExecutor(environment: .testing()))
        model.result = .info("Older result")
        model.inputText = "/clear"

        await model.submit()

        #expect(model.inputText == "")
        #expect(model.result == .none)
        #expect(model.thomasState == .ready)
    }
}
