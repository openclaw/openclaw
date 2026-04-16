import Foundation
import OpenClawIPC
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct RemoteGatewayProbeTests {
    @Test func `unknown SSH host failure prompts trust bootstrap`() {
        let response = Response(
            ok: false,
            message: "exit 255",
            payload: Data(
                """
                No ED25519 host key is known for gateway.example.com and you have requested strict checking.
                Host key verification failed.
                """.utf8))

        let failure = RemoteGatewayProbe._testFormatSSHFailure(
            response,
            target: "user@gateway.example.com:2222")

        #expect(failure.contains("not trusted yet"))
        #expect(failure.contains("`ssh -p 2222 gateway.example.com`"))
        #expect(!failure.contains("ssh-keygen -R"))
    }

    @Test func `changed SSH host key failure suggests removing old key`() {
        let response = Response(
            ok: false,
            message: "exit 255",
            payload: Data(
                """
                @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                @    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
                @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                Host key verification failed.
                """.utf8))

        let failure = RemoteGatewayProbe._testFormatSSHFailure(
            response,
            target: "user@gateway.example.com:2222")

        #expect(failure.contains("ssh-keygen -R [gateway.example.com]:2222"))
    }
}
