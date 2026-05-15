import Testing
@testable import OpenClaw

struct AmbientCommandRegistryTests {
    @Test func `plain text parses as prompt`() {
        let parsed = AmbientCommandRegistry.default.parse("Summarize my latest messages")

        #expect(parsed == .prompt("Summarize my latest messages"))
    }

    @Test func `known slash command parses with arguments`() {
        let parsed = AmbientCommandRegistry.default.parse("/intensity 70")

        #expect(parsed == .command(name: "intensity", arguments: "70"))
    }

    @Test func `unknown slash command reports closest suggestions`() {
        let parsed = AmbientCommandRegistry.default.parse("/rest")

        guard case let .unknown(name, suggestions) = parsed else {
            Issue.record("Expected unknown command")
            return
        }

        #expect(name == "rest")
        #expect(suggestions.map(\.name).contains("restart-gateway"))
        #expect(suggestions.map(\.name).contains("reset-tunnel"))
    }

    @Test func `suggestions filter by prefix and include help text`() {
        let suggestions = AmbientCommandRegistry.default.suggestions(for: "/ca")

        #expect(suggestions.map(\.name) == ["camera", "canvas"])
        #expect(suggestions.first?.group == .modes)
        #expect(suggestions.last?.group == .surfaces)
        #expect(suggestions.last?.description == "Open or close Canvas")
    }

    @Test func `empty slash returns grouped suggestions`() {
        let suggestions = AmbientCommandRegistry.default.suggestions(for: "/")

        #expect(suggestions.contains(where: { $0.name == "help" }))
        #expect(suggestions.contains(where: { $0.name == "canvas" }))
        #expect(suggestions.contains(where: { $0.name == "restart-gateway" }))
    }
}
