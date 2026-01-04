import Testing
@testable import Clawdbot

@Suite(.serialized)
struct BridgeServerTests {
    @Test func bridgeServerExercisesPaths() async {
        let server = BridgeServer()
        await server.exerciseForTesting()
    }
}
