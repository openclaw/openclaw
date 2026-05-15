import Testing
@testable import OpenClaw

@MainActor
struct AmbientCommandDockActionTests {
    @Test func `intensity command validates numeric range`() async {
        let executor = AmbientCommandDockActionExecutor(environment: .testing())

        let low = await executor.execute(name: "intensity", arguments: "5")
        let valid = await executor.execute(name: "intensity", arguments: "70")

        #expect(low == .failure("Usage: /intensity 10-100"))
        #expect(valid == .success("Ambient intensity set to 70%"))
    }

    @Test func `help command returns grouped command hint`() async {
        let executor = AmbientCommandDockActionExecutor(environment: .testing())

        let result = await executor.execute(name: "help", arguments: "")

        guard case let .info(message) = result else {
            Issue.record("Expected info")
            return
        }
        #expect(message.contains("/canvas"))
        #expect(message.contains("/restart-gateway"))
    }

    @Test func `plain prompt sends without voice wake prefix`() async {
        var capturedPrompt: String?
        let executor = AmbientCommandDockActionExecutor(environment: .testing(
            sendPrompt: { prompt in
                capturedPrompt = prompt
                return .success("Sent to Thomas")
            }))

        let result = await executor.sendPrompt("check my latest iMessage")

        #expect(result == .success("Sent to Thomas"))
        #expect(capturedPrompt == "check my latest iMessage")
    }
}
