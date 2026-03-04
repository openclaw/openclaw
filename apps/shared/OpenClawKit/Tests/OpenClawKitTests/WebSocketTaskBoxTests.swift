import Foundation
import Testing
@testable import OpenClawKit

private final class DoublePingWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running

    func resume() {}
    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {}
    func send(_: URLSessionWebSocketTask.Message) async throws {}
    func receive() async throws -> URLSessionWebSocketTask.Message { .string("") }
    func receive(completionHandler _: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {}

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
        pongReceiveHandler(URLError(.networkConnectionLost))
    }
}

struct WebSocketTaskBoxTests {
    @Test
    func sendPingIgnoresSecondCallbackResume() async throws {
        let task = WebSocketTaskBox(task: DoublePingWebSocketTask())
        try await task.sendPing()
    }
}
