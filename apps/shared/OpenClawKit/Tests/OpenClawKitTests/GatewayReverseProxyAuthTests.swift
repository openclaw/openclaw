import Foundation
import Testing
@testable import OpenClawKit

private final class NonRespondingWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State { .running }
    func resume() {}
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        _ = message
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        // Fail the handshake fast; the upgrade task has already been created by then.
        throw URLError(.badServerResponse)
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        completionHandler(.failure(URLError(.badServerResponse)))
    }
}

private final class HeaderCapturingSession: WebSocketSessioning, @unchecked Sendable {
    private let lock = NSLock()
    private var _capturedHeaders: [String: String] = [:]
    private var _headerVariantCalls = 0

    var capturedHeaders: [String: String] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self._capturedHeaders
    }

    var headerVariantCalls: Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self._headerVariantCalls
    }

    func makeWebSocketTask(url _: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: NonRespondingWebSocketTask())
    }

    func makeWebSocketTask(url _: URL, headers: [String: String]) -> WebSocketTaskBox {
        self.lock.lock()
        self._capturedHeaders = headers
        self._headerVariantCalls += 1
        self.lock.unlock()
        return WebSocketTaskBox(task: NonRespondingWebSocketTask())
    }
}

@Suite(.serialized)
struct GatewayReverseProxyAuthTests {
    @Test
    func `basic auth headers encode credentials`() {
        let headers = GatewayProxyAuth.basicAuthHeaders(username: "admin", password: "s3cr3t")
        let expected = "Basic " + Data("admin:s3cr3t".utf8).base64EncodedString()
        #expect(headers["Authorization"] == expected)
    }

    @Test
    func `basic auth headers allow an empty password`() {
        let headers = GatewayProxyAuth.basicAuthHeaders(username: "admin", password: "")
        let expected = "Basic " + Data("admin:".utf8).base64EncodedString()
        #expect(headers["Authorization"] == expected)
    }

    @Test
    func `basic auth headers are empty without a username`() {
        #expect(GatewayProxyAuth.basicAuthHeaders(username: nil, password: "x").isEmpty)
        #expect(GatewayProxyAuth.basicAuthHeaders(username: "   ", password: "x").isEmpty)
    }

    @Test
    func `channel forwards proxy authorization on the upgrade request`() async throws {
        let session = HeaderCapturingSession()
        let url = try #require(URL(string: "wss://gateway.example.test/openclaw"))
        let channel = GatewayChannelActor(
            url: url,
            token: nil,
            additionalHeaders: GatewayProxyAuth.basicAuthHeaders(username: "admin", password: "s3cr3t"),
            session: WebSocketSessionBox(session: session))

        // The fake task never completes the handshake; we only require the upgrade
        // task to be created, which happens synchronously before the handshake.
        _ = try? await channel.connect()
        await channel.shutdown()

        let expected = "Basic " + Data("admin:s3cr3t".utf8).base64EncodedString()
        #expect(session.headerVariantCalls >= 1)
        #expect(session.capturedHeaders["Authorization"] == expected)
    }

    @Test
    func `channel without proxy auth sends no authorization header`() async throws {
        let session = HeaderCapturingSession()
        let url = try #require(URL(string: "wss://gateway.example.test/openclaw"))
        let channel = GatewayChannelActor(
            url: url,
            token: nil,
            session: WebSocketSessionBox(session: session))

        _ = try? await channel.connect()
        await channel.shutdown()

        #expect(session.capturedHeaders["Authorization"] == nil)
    }
}
