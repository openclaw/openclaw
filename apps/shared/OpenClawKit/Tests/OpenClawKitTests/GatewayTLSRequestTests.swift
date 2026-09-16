import Foundation
import Network
import OpenClawKit
import Testing

/// Real URLSession I/O for the header-only, no-redirect transport used by Access admission.
@MainActor
private final class GatewayHTTPFixture {
    private let listener: NWListener
    private let reply: String
    private var connections: [NWConnection] = []
    private(set) var requests: [String] = []

    init(reply: String) throws {
        self.reply = reply
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        self.listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        self.listener.start(queue: .main)
    }

    func readyURL() async throws -> URL {
        let deadline = ContinuousClock.now + .seconds(3)
        while self.listener.state != .ready {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(10))
        }
        let port = try #require(self.listener.port)
        return try #require(URL(string: "http://127.0.0.1:\(port.rawValue)/probe"))
    }

    func stop() {
        self.listener.cancel()
        self.connections.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        self.connections.append(connection)
        connection.start(queue: .main)
        self.receive(connection, buffered: Data())
    }

    private func receive(_ connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, ended, error in
            Task { @MainActor in
                guard let self else { return }
                var accumulated = buffered
                if let data { accumulated.append(data) }
                guard accumulated.count < 65536 else { connection.cancel()
                    return
                }
                if let text = String(data: accumulated, encoding: .utf8), text.contains("\r\n\r\n") {
                    self.requests.append(text)
                    connection.send(content: Data(self.reply.utf8), completion: .contentProcessed { _ in })
                } else if !ended, error == nil {
                    self.receive(connection, buffered: accumulated)
                }
            }
        }
    }
}

@Suite(.serialized)
struct GatewayTLSRequestTests {
    private static func session() -> GatewayTLSPinningSession {
        GatewayTLSPinningSession(
            params: GatewayTLSParams(required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: false,
            allowsStoredCredentials: false)
    }

    @Test @MainActor func `header-only probe accepts a nonempty body and never forwards a credential on redirect`() async throws {
        let destination = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { destination.stop() }
        let destinationURL = try await destination.readyURL()
        let source =
            try GatewayHTTPFixture(
                reply: "HTTP/1.1 302 Found\r\nLocation: \(destinationURL)\r\nContent-Length: 3\r\n\r\nabc")
        defer { source.stop() }
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        var request = try await URLRequest(url: source.readyURL())
        request.setValue("test-only-ingress-grant", forHTTPHeaderField: "Cf-Access-Token")
        let response = try await session.response(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 302)
        #expect(response.url == request.url)
        #expect(source.requests.count == 1)
        #expect(source.requests[0].lowercased().contains("cf-access-token: test-only-ingress-grant"))
        #expect(destination.requests.isEmpty)
    }

    @Test @MainActor func `bounded response rejects an oversized body`() async throws {
        let server = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc")
        defer { server.stop() }
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        let request = try await URLRequest(url: server.readyURL())
        await #expect(throws: GatewayBoundedDataError.self) { try await session.data(for: request, maximumBytes: 2) }
    }

    @Test @MainActor func `cancellation interrupts a stalled body`() async throws {
        let server = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\na")
        defer { server.stop() }
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        let request = try await URLRequest(url: server.readyURL())
        let pending = Task { try await session.data(for: request, maximumBytes: 20) }
        let deadline = ContinuousClock.now + .seconds(3)
        while server.requests.isEmpty {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            await Task.yield()
        }
        pending.cancel()
        switch await pending.result {
        case .success: Issue.record("cancelled request returned a body")
        case .failure: break
        }
    }
}
