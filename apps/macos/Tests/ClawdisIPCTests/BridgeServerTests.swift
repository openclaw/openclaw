import Testing
@testable import Clawdis

@Suite(.serialized)
struct BridgeServerTests {
    @Test func bridgeServerExercisesPaths() async {
        let server = BridgeServer()
        await server.exerciseForTesting()
    }
}
