import Foundation
import Network
import Testing
@testable import OpenClawKit

private final class RejectedTLSSession: WebSocketSessioning, WebSocketTasking, GatewayTLSFailureProviding,
    @unchecked Sendable
{
    let failure: GatewayTLSValidationFailure
    let transportError: Error

    init(failure: GatewayTLSValidationFailure, transportError: Error) {
        self.failure = failure
        self.transportError = transportError
    }

    func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
        self.failure
    }

    func makeWebSocketTask(url _: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: self)
    }

    var state: URLSessionTask.State {
        .running
    }

    func resume() {}
    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {}
    func send(_: URLSessionWebSocketTask.Message) async throws {
        throw self.transportError
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(self.transportError)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        throw self.transportError
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        completionHandler(.failure(self.transportError))
    }
}

struct GatewayChannelTLSFailureTests {
    @Test(arguments: [false, true])
    func `recorded pin mismatch survives transport failure`(networkFramework: Bool) async throws {
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example",
            storeKey: "test-gateway",
            expectedFingerprint: String(repeating: "a", count: 64),
            observedFingerprint: String(repeating: "b", count: 64),
            systemTrustOk: false)
        let transportError: Error = networkFramework
            ? NWError.tls(-9807)
            : URLError(.serverCertificateUntrusted)
        let session = RejectedTLSSession(failure: failure, transportError: transportError)
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "wss://gateway.example")),
            token: nil,
            session: WebSocketSessionBox(session: session))
        do {
            try await channel.connect()
            Issue.record("Certificate rejection must fail the connection")
        } catch {
            #expect((error as? GatewayTLSValidationError)?.failure == failure)
        }
        await channel.shutdown()
    }
}
