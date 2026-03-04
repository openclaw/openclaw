import Foundation
import Testing
@testable import OpenClawKit

private final class DoublePingWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        _ = message
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
        pongReceiveHandler(URLError(.networkConnectionLost))
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        .string("")
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        completionHandler(.failure(URLError(.cannotParseResponse)))
    }
}

struct WebSocketTaskBoxTests {
    @Test
    func sendPingIgnoresSecondCompletion() async throws {
        let box = WebSocketTaskBox(task: DoublePingWebSocketTask())
        try await box.sendPing()
        #expect(true)
    }
}
