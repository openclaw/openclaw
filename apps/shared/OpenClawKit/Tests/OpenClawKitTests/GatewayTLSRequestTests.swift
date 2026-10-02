import Foundation
import Network
import Testing
@testable import OpenClawKit

/// Real URLSession I/O for the header-only, no-redirect transport used by Access admission.
@MainActor
private final class GatewayHTTPFixture {
    private let listener: NWListener
    private let reply: String
    private let ready = AsyncThrowingStream<Void, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private let received = AsyncThrowingStream<Void, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private var stopped = false
    private var connections: [NWConnection] = []
    private(set) var requests: [String] = []

    init(reply: String) throws {
        self.reply = reply
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        let ready = self.ready.continuation
        self.listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.yield(())
                ready.finish()
            case let .failed(error): ready.finish(throwing: error)
            case .cancelled: ready.finish(throwing: CancellationError())
            default: break
            }
        }
        self.listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in
                guard let self else { connection.cancel()
                    return
                }
                self.accept(connection)
            }
        }
        self.listener.start(queue: .main)
    }

    func readyURL() async throws -> URL {
        try await Self.wait(for: self.ready.stream)
        try #require(self.listener.state == .ready)
        let port = try #require(self.listener.port)
        return try #require(URL(string: "http://127.0.0.1:\(port.rawValue)/probe"))
    }

    func waitForRequest() async throws {
        if self.requests.isEmpty { try await Self.wait(for: self.received.stream) }
        try #require(!self.requests.isEmpty)
    }

    private static func wait(for signal: AsyncThrowingStream<Void, Error>) async throws {
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            var iterator = signal.makeAsyncIterator()
            // Only an owner event yields; cancellation or teardown must not count as readiness.
            guard try await iterator.next() != nil else { throw CancellationError() }
            try Task.checkCancellation()
        }
    }

    func stop() {
        guard !self.stopped else { return }
        self.stopped = true
        self.ready.continuation.finish(throwing: CancellationError())
        self.received.continuation.finish(throwing: CancellationError())
        self.listener.cancel()
        self.connections.forEach { $0.cancel() }
    }

    private func accept(_ connection: NWConnection) {
        guard !self.stopped else { connection.cancel()
            return
        }
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
                    self.received.continuation.yield(())
                    self.received.continuation.finish()
                    connection.send(content: Data(self.reply.utf8), completion: .contentProcessed { _ in })
                } else if !ended, error == nil {
                    self.receive(connection, buffered: accumulated)
                }
            }
        }
    }
}

struct GatewayTLSRequestTests {
    private static func session(allowsRedirects: Bool = false) -> GatewayTLSPinningSession {
        GatewayTLSPinningSession(
            params: GatewayTLSParams(required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
            allowsRedirects: allowsRedirects,
            allowsStoredCredentials: false)
    }

    @Test @MainActor func `header-only probe preserves enabled redirects`() async throws {
        let destination = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { destination.stop() }
        let destinationURL = try await destination.readyURL()
        let source = try GatewayHTTPFixture(
            reply: "HTTP/1.1 302 Found\r\nLocation: \(destinationURL)\r\nContent-Length: 0\r\n\r\n")
        defer { source.stop() }
        let session = Self.session(allowsRedirects: true)
        defer { session.finishTasksAndInvalidate() }
        let request = try await URLRequest(url: source.readyURL())
        let response = try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            try await session.response(for: request)
        }
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(response.url == destinationURL)
        #expect(source.requests.count == 1)
        #expect(destination.requests.count == 1)
    }

    @Test(arguments: [200, 302])
    @MainActor func `header-only probe returns before body completion and refuses redirects`(
        statusCode: Int) async throws
    {
        let destination = try GatewayHTTPFixture(reply: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { destination.stop() }
        let destinationURL = try await destination.readyURL()
        let source =
            try GatewayHTTPFixture(
                reply: """
                HTTP/1.1 \(statusCode) Test\r
                Location: \(destinationURL)\r
                Content-Type: text/html; charset=utf-8\r
                Content-Length: 10\r
                \r
                <
                """)
        defer { source.stop() }
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        var request = try await URLRequest(url: source.readyURL())
        request.setValue("test-only-ingress-grant", forHTTPHeaderField: "Cf-Access-Token")
        // URLSession can wait for initial body data before delivering a response.
        // Keep nine declared bytes outstanding so a full-body implementation times out.
        let response = try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) { [request] in
            try await session.response(for: request)
        }
        #expect((response as? HTTPURLResponse)?.statusCode == statusCode)
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

    @Test(arguments: [true, false])
    @MainActor func `cancellation interrupts incomplete HTTP responses`(headerOnly: Bool) async throws {
        let server = try GatewayHTTPFixture(reply: headerOnly ? "" : "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\na")
        defer { server.stop() }
        let session = Self.session()
        defer { session.finishTasksAndInvalidate() }
        let request = try await URLRequest(url: server.readyURL())
        let pending = Task {
            if headerOnly {
                _ = try await session.response(for: request)
            } else {
                _ = try await session.data(for: request, maximumBytes: 20)
            }
        }
        defer { pending.cancel() }
        do {
            try await server.waitForRequest()
        } catch {
            pending.cancel()
            server.stop()
            _ = try? await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
                await pending.result
            }
            throw error
        }
        pending.cancel()
        let result = try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            await pending.result
        }
        switch result {
        case .success: Issue.record("cancelled request completed successfully")
        case .failure: break
        }
    }
}
