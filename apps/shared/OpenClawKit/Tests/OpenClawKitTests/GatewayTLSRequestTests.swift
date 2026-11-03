import Foundation
import Network
import Testing
@testable import OpenClawKit

/// Real URLSession I/O for the header-only, no-redirect transport used by Access admission.
/// The serial queue owns mutable state and callbacks, independently of MainActor test work.
private final class GatewayHTTPFixture: @unchecked Sendable {
    private let queue = DispatchQueue(label: "gateway-http-fixture")
    private let listener: NWListener
    private let reply: String
    private let ready = AsyncThrowingStream<Void, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private let received = AsyncThrowingStream<Void, Error>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private var stopped = false
    private var connections: [NWConnection] = []
    private var recordedRequests: [String] = []

    var requests: [String] {
        self.queue.sync { self.recordedRequests }
    }

    init(reply: String) throws {
        self.reply = reply
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        self.listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            dispatchPrecondition(condition: .onQueue(self.queue))
            guard !self.stopped else { return }
            switch state {
            case .ready:
                self.ready.continuation.yield(())
                self.ready.continuation.finish()
            case let .failed(error): self.ready.continuation.finish(throwing: error)
            case .cancelled: self.ready.continuation.finish(throwing: CancellationError())
            default: break
            }
        }
        self.listener.newConnectionHandler = { [weak self] connection in
            guard let self else {
                connection.cancel()
                return
            }
            self.accept(connection)
        }
        self.listener.start(queue: self.queue)
    }

    func readyURL() async throws -> URL {
        try await Self.wait(for: self.ready.stream)
        let observation = self.queue.sync { (state: self.listener.state, port: self.listener.port) }
        try #require(observation.state == .ready)
        let port = try #require(observation.port)
        return try #require(URL(string: "http://127.0.0.1:\(port.rawValue)/probe"))
    }

    func waitForRequest() async throws {
        if self.requests.isEmpty { try await Self.wait(for: self.received.stream) }
        try #require(!self.requests.isEmpty)
    }

    @concurrent
    private static func wait(for signal: AsyncThrowingStream<Void, Error>) async throws {
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            var iterator = signal.makeAsyncIterator()
            // Only an owner event yields; cancellation or teardown must not count as readiness.
            guard try await iterator.next() != nil else { throw CancellationError() }
            try Task.checkCancellation()
        }
    }

    func stop() {
        self.queue.sync {
            guard !self.stopped else { return }
            self.stopped = true
            self.ready.continuation.finish(throwing: CancellationError())
            self.received.continuation.finish(throwing: CancellationError())
            self.listener.cancel()
            self.connections.forEach { $0.cancel() }
            self.connections.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        dispatchPrecondition(condition: .onQueue(self.queue))
        guard !self.stopped else { connection.cancel()
            return
        }
        self.connections.append(connection)
        connection.start(queue: self.queue)
        self.receive(connection, buffered: Data())
    }

    private func receive(_ connection: NWConnection, buffered: Data) {
        dispatchPrecondition(condition: .onQueue(self.queue))
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, ended, error in
            guard let self else { return }
            dispatchPrecondition(condition: .onQueue(self.queue))
            guard !self.stopped else { return }
            var accumulated = buffered
            if let data { accumulated.append(data) }
            guard accumulated.count < 65536 else {
                connection.cancel()
                return
            }
            if let text = String(data: accumulated, encoding: .utf8), text.contains("\r\n\r\n") {
                self.recordedRequests.append(text)
                self.received.continuation.yield(())
                self.received.continuation.finish()
                connection.send(content: Data(self.reply.utf8), completion: .contentProcessed { _ in })
            } else if !ended, error == nil {
                self.receive(connection, buffered: accumulated)
            }
        }
    }
}

private final class GatewayHTTPFailureFixture: GatewayTLSFailureProviding {
    var failure: GatewayTLSValidationFailure?
    private(set) var consumed = 0

    init(kind: GatewayTLSValidationFailureKind = .pinMismatch) {
        self.failure = GatewayTLSValidationFailure(
            kind: kind, host: "gateway.example.test", storeKey: "test-profile",
            expectedFingerprint: "expected", observedFingerprint: "observed", systemTrustOk: false, port: 8443)
    }

    func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
        self.consumed += 1
        defer { self.failure = nil }
        return self.failure
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

    @Test(arguments: [GatewayTLSValidationFailureKind.pinMismatch, .untrustedCertificate, .authorityMismatch])
    func `HTTP trust reconciliation keeps typed details and consumes them once`(
        kind: GatewayTLSValidationFailureKind) throws
    {
        let provider = GatewayHTTPFailureFixture(kind: kind)
        let failure = provider.failure
        // A rejected challenge can cancel URLSession without canceling the caller Task.
        let transport = URLError(.cancelled, userInfo: ["test-marker": "original"])
        let mapped = try #require(provider.consumeHTTPFailure(transport) as? GatewayTLSValidationError)
        #expect(mapped.failure == failure)
        #expect(mapped.context == "gateway request")
        #expect(provider.consumed == 1)
        #expect(provider.failure == nil)
        let later = try #require(provider.consumeHTTPFailure(transport) as? URLError)
        #expect(later.code == transport.code)
        #expect(later.userInfo["test-marker"] as? String == "original")
        #expect(provider.consumed == 2)
    }

    @Test func `HTTP reconciliation preserves a URL error without a recorded trust failure`() throws {
        let provider = GatewayHTTPFailureFixture()
        provider.failure = nil
        let transport = URLError(.networkConnectionLost, userInfo: ["test-marker": "original"])
        let result = try #require(provider.consumeHTTPFailure(transport) as? URLError)
        #expect(result.code == transport.code)
        #expect(result.userInfo["test-marker"] as? String == "original")
        #expect(provider.consumed == 1)
    }

    @Test func `non URL failures discard stale HTTP trust context without replacing the error`() {
        let provider = GatewayHTTPFailureFixture()
        let original = NSError(domain: "test-error", code: 42)
        #expect(provider.consumeHTTPFailure(original) as NSError === original)
        #expect(provider.failure == nil)
        #expect(provider.consumed == 1)
        let canceled = GatewayHTTPFailureFixture()
        #expect(canceled.consumeHTTPFailure(CancellationError()) is CancellationError)
        #expect(canceled.failure == nil)
        #expect(canceled.consumed == 1)
    }

    @Test @MainActor func `caller cancellation takes precedence and discards HTTP trust context`() async throws {
        let provider = GatewayHTTPFailureFixture()
        let original = URLError(.cancelled, userInfo: ["test-marker": "caller-canceled"])
        let caller = Task { provider.consumeHTTPFailure(original) }
        // MainActor has not yielded, so the reconciliation runs in an already-canceled caller.
        caller.cancel()
        let result = try #require(await caller.value as? URLError)
        #expect(result.code == original.code)
        #expect(result.userInfo["test-marker"] as? String == "caller-canceled")
        #expect(provider.failure == nil)
        #expect(provider.consumed == 1)
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
