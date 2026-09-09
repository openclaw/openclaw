import Foundation
import OpenClawProtocol
@testable import OpenClawKit

final class GatewayOperatorHTTPFixture: @unchecked Sendable {
    static let connectionID = "11111111-1111-4111-8111-111111111111"
    static let connectionKey = String(repeating: "a", count: 43)
    static let gatewayID = "watch-http-fixture"
    static let scopes = ["operator.read", "operator.talk"]
    static let token = "paired-operator-fixture"

    let session: GatewayOperatorHTTPSession
    let identity: DeviceIdentity
    private let grantedScopes: [String]
    private let requests: AsyncStream<GatewayOperatorHTTPExchange>
    private let continuation: AsyncStream<GatewayOperatorHTTPExchange>.Continuation
    private let lock = NSLock()
    private var recorded: [GatewayOperatorHTTPExchange] = []

    init(
        gatewayID: String = GatewayOperatorHTTPFixture.gatewayID,
        scopes: [String] = GatewayOperatorHTTPFixture.scopes) throws
    {
        let (requests, continuation) = AsyncStream<GatewayOperatorHTTPExchange>.makeStream()
        self.requests = requests
        self.continuation = continuation
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
              DeviceAuthStore.storeTokenPersisted(
                  deviceId: identity.deviceId, role: "operator", token: Self.token,
                  scopes: scopes, gatewayID: gatewayID, profile: .primary),
              let endpoint = URL(string: "https://gateway.example.invalid/team")
        else { throw URLError(.cannotCreateFile) }
        self.identity = identity
        self.grantedScopes = scopes
        self.session = try GatewayOperatorHTTPSession(
            endpoint: endpoint, gatewayID: gatewayID, makeHTTP: {
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [GatewayOperatorHTTPURLProtocol.self]
                return GatewayTLSPinningSession(
                    configuration: configuration,
                    params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
                    allowsRedirects: false, allowsStoredCredentials: false)
            })
        GatewayOperatorHTTPURLProtocol.install(self)
    }

    func stop() async {
        await self.session.disconnect()
        GatewayOperatorHTTPURLProtocol.install(nil)
        self.continuation.finish()
    }

    var snapshot: [GatewayOperatorHTTPExchange] {
        self.lock.withLock { self.recorded }
    }

    fileprivate func receive(_ exchange: GatewayOperatorHTTPExchange) {
        self.lock.withLock { self.recorded.append(exchange) }
        if exchange.request.httpMethod == "DELETE" {
            exchange.respond(status: 204, body: Data())
        }
        self.continuation.yield(exchange)
    }

    func next() async throws -> GatewayOperatorHTTPExchange {
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            var iterator = self.requests.makeAsyncIterator()
            guard let exchange = await iterator.next() else { throw CancellationError() }
            return exchange
        }
    }

    func beginConnect(
        onClosed: @escaping @Sendable (any Error) async -> Void = { _ in }) -> Task<HelloOk, any Error>
    {
        Task {
            try await self.session.connect(
                options: GatewayConnectOptions(
                    role: "operator", scopes: self.grantedScopes, scopesAreExplicit: true, caps: [], commands: [],
                    permissions: [:], clientId: "openclaw-watchos", clientMode: "node", clientDisplayName: nil,
                    deviceIdentityProfile: .primary, deviceAuthGatewayID: Self.gatewayID),
                consumeHello: { _, _ in }, consumeEvent: { _, _ in }, onClosed: onClosed)
        }
    }

    static func cancelQueuedMutation(on session: isolated GatewayOperatorHTTPSession) async throws -> ResponseFrame {
        let started = AsyncStream<Void>.makeStream()
        let mutation = Task {
            started.continuation.yield(())
            return try await session.request(method: "chat.send", consume: { _, _ in })
        }
        var iterator = started.stream.makeAsyncIterator()
        _ = await iterator.next()
        // Both jobs inherit the connection actor. Admission suspends before this
        // continuation cancels; no URLProtocol cancellation callback is used as a join.
        mutation.cancel()
        return try await mutation.value
    }

    static func beginBody() throws -> Data {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return try JSONSerialization.data(withJSONObject: [
            "connectionId": self.connectionID, "connectionKey": self.connectionKey,
            "challenge": ["nonce": "begin-only-challenge", "ts": now],
            "handshakeExpiresAtMs": now + 30000,
            "limits": [
                "maxPreauthPayloadBytes": 65536, "maxPayloadBytes": 25 * 1024 * 1024,
                "maxBufferedBytes": 50 * 1024 * 1024, "maxQueuedFrames": 256,
                "maxBatchFrames": 64, "maxPollWaitMs": 25000,
                "idleTimeoutMs": 60000, "maxConnections": 256,
            ],
        ])
    }

    static func hello(
        requestID: String, scopes: [String] = GatewayOperatorHTTPFixture.scopes) throws -> Data
    {
        let hello = HelloOk(
            type: "hello-ok", _protocol: GATEWAY_PROTOCOL_VERSION,
            server: ["connId": AnyCodable(self.connectionID)], features: [:],
            snapshot: Snapshot(
                presence: [],
                health: [:],
                stateversion: StateVersion(presence: 0, health: 0),
                uptimems: 1),
            auth: [
                "method": AnyCodable("device-token"), "role": AnyCodable("operator"),
                "scopes": AnyCodable(scopes),
            ],
            policy: [:])
        return try self.delivery(
            requestID: requestID, payload: JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(hello)),
            cursor: 1, accepted: 1)
    }

    static func delivery(requestID: String, payload: AnyCodable, cursor: Int, accepted: Int) throws -> Data {
        struct Delivery: Encodable {
            let cursor: Int
            let frame: ResponseFrame
        }
        struct Poll: Encodable {
            let acceptedClientSeq: Int
            let frames: [Delivery]
        }
        return try JSONEncoder().encode(Poll(
            acceptedClientSeq: accepted,
            frames: [Delivery(
                cursor: cursor,
                frame: ResponseFrame(type: "res", id: requestID, ok: true, payload: payload))]))
    }
}

final class GatewayOperatorHTTPExchange: @unchecked Sendable {
    let request: URLRequest
    let body: Data
    private let sendResponse: @Sendable (Int, Data) -> Void
    private let sendFailure: @Sendable (URLError) -> Void

    fileprivate init(_ transport: GatewayOperatorHTTPURLProtocol) throws {
        self.sendResponse = { transport.respond(status: $0, body: $1) }
        self.sendFailure = { transport.client?.urlProtocol(transport, didFailWithError: $0) }
        self.request = transport.request
        if let body = self.request.httpBody {
            self.body = body
        } else if let stream = self.request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var body = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0 else { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
                if count == 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
            self.body = body
        } else {
            self.body = Data()
        }
    }

    init(
        request: URLRequest,
        body: Data,
        respond: @escaping @Sendable (Int, Data) -> Void,
        fail: @escaping @Sendable (URLError) -> Void)
    {
        self.request = request
        self.body = body
        self.sendResponse = respond
        self.sendFailure = fail
    }

    var object: [String: Any] {
        get throws { try JSONSerialization.jsonObject(with: self.body) as? [String: Any] ?? [:] }
    }

    var frame: RequestFrame {
        get throws {
            struct Envelope: Decodable { let frame: RequestFrame }
            return try JSONDecoder().decode(Envelope.self, from: self.body).frame
        }
    }

    func respond(status: Int = 200, body: Data) {
        self.sendResponse(status, body)
    }

    func accept(_ sequence: Int) {
        self.respond(status: 202, body: Data("{\"acceptedClientSeq\":\(sequence)}".utf8))
    }

    func fail(_ error: URLError) {
        self.sendFailure(error)
    }
}

final class GatewayOperatorHTTPGate: @unchecked Sendable {
    private let entered = AsyncStream<Void>.makeStream()
    private let released = AsyncStream<Void>.makeStream()

    func waitUntilEntered() async throws {
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            var iterator = self.entered.stream.makeAsyncIterator()
            guard await iterator.next() != nil else { throw CancellationError() }
        }
    }

    func wait() async {
        self.entered.continuation.yield(())
        var iterator = self.released.stream.makeAsyncIterator()
        _ = await iterator.next()
    }

    func release() {
        self.released.continuation.yield(())
        self.released.continuation.finish()
    }
}

private final class GatewayOperatorHTTPURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var fixture: GatewayOperatorHTTPFixture?

    static func install(_ fixture: GatewayOperatorHTTPFixture?) {
        self.lock.withLock { self.fixture = fixture }
    }

    override class func canInit(with _: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            let exchange = try GatewayOperatorHTTPExchange(self)
            guard let fixture = Self.lock.withLock({ Self.fixture }) else { throw URLError(.cancelled) }
            fixture.receive(exchange)
        } catch {
            self.client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    func respond(status: Int, body: Data) {
        guard let url = self.request.url,
              let response = HTTPURLResponse(
                  url: url, statusCode: status, httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json", "Content-Length": String(body.count)])
        else { return }
        self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        self.client?.urlProtocol(self, didLoad: body)
        self.client?.urlProtocolDidFinishLoading(self)
    }
}
