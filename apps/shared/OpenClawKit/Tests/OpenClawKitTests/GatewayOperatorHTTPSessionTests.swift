import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct GatewayOperatorHTTPSessionTests {
    @Test(arguments: ["scheme", "user", "password", "query", "fragment"])
    func `operator transport refuses insecure or credential-bearing endpoints`(_ component: String) throws {
        var endpoint = try #require(URLComponents(string: "https://gateway.example.invalid"))
        switch component {
        case "scheme": endpoint.scheme = "http"
        case "user": endpoint.user = "synthetic-user"
        case "password":
            endpoint.user = "synthetic-user"
            endpoint.password = "synthetic-password"
        case "query": endpoint.queryItems = [URLQueryItem(name: "token", value: "synthetic-token")]
        case "fragment": endpoint.fragment = "synthetic-token"
        default: Issue.record("Unknown endpoint rejection case")
        }
        let url = try #require(endpoint.url)
        do {
            _ = try GatewayOperatorHTTPSession(endpoint: url, gatewayID: "watch-test")
            Issue.record("Credential-bearing or insecure endpoint was accepted")
        } catch GatewayOperatorHTTPError.invalidEndpoint {}
    }

    @Test(arguments: [
        [], ["operator.admin"], ["operator.pairing"], ["operator.questions"],
        ["operator.read", "operator.read"], ["operator.read", "operator.talk.secrets"],
    ])
    func `unsupported scopes fail before creating an HTTP connection`(_ scopes: [String]) async throws {
        let session = try GatewayOperatorHTTPSession(
            endpoint: #require(URL(string: "https://gateway.example.invalid")),
            gatewayID: "watch-test")
        let options = GatewayConnectOptions(
            role: "operator", scopes: scopes, scopesAreExplicit: true, caps: [], commands: [],
            permissions: [:], clientId: "openclaw-watchos", clientMode: "node", clientDisplayName: nil,
            deviceIdentityProfile: .primary, deviceAuthGatewayID: "watch-test")
        do {
            _ = try await session.connect(
                options: options,
                consumeHello: { _, _ in Issue.record("Unexpected authenticated hello") },
                consumeEvent: { _, _ in Issue.record("Unexpected Gateway event") },
                onClosed: { _ in })
            Issue.record("Unsupported operator scopes connected")
        } catch GatewayOperatorHTTPError.pairingRequired {}
    }

    @Test(.stateDirectoryIsolated)
    func `node credentials cannot authorize an operator connection`() async throws {
        let identity = DeviceIdentityStore.loadOrCreate()
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: identity.deviceId, role: "node", token: "node-credential",
            scopes: [], gatewayID: "watch-test", profile: .primary))
        let session = try GatewayOperatorHTTPSession(
            endpoint: #require(URL(string: "https://gateway.example.invalid")),
            gatewayID: "watch-test")
        let options = GatewayConnectOptions(
            role: "operator", scopes: ["operator.read", "operator.talk"],
            scopesAreExplicit: true, caps: [], commands: [], permissions: [:],
            clientId: "openclaw-watchos", clientMode: "node", clientDisplayName: nil,
            deviceIdentityProfile: .primary, deviceAuthGatewayID: "watch-test")
        do {
            _ = try await session.connect(
                options: options,
                consumeHello: { _, _ in Issue.record("Node credential became operator authority") },
                consumeEvent: { _, _ in },
                onClosed: { _ in })
            Issue.record("Node-only pairing connected as an operator")
        } catch GatewayOperatorHTTPError.pairingRequired {}
    }
}

@Suite(.serialized)
struct GatewayOperatorHTTPWireTests {
    @Test(.stateDirectoryIsolated)
    func `begin challenge and tokenless hello establish one signed operator connection`() async throws {
        try await Self.withFixture { fixture in
            _ = try await Self.connect(fixture)
            let stored = DeviceAuthStore.loadToken(
                deviceId: fixture.identity.deviceId, role: "operator",
                gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary)
            #expect(stored?.token == GatewayOperatorHTTPFixture.token)
            #expect(stored?.scopes == GatewayOperatorHTTPFixture.scopes)
            #expect(fixture.snapshot.count == 4)
        }
    }

    @Test(.stateDirectoryIsolated)
    func `lost frame acceptance retries identical bytes on the same connection without redispatch`() async throws {
        try await Self.withFixture { fixture in
            _ = try await Self.connect(fixture)
            let request = Task {
                try await fixture.session.request(method: "chat.send", params: AnyCodable([
                    "sessionKey": "session-exact", "message": "hello", "idempotencyKey": "one-send",
                ]), consume: { _, _ in })
            }
            let first = try await Self.next(fixture, suffix: "frames")
            #expect(try first.object["clientSeq"] as? Int == 2)
            #expect(try first.object["ack"] as? Int == 1)
            first.fail(URLError(.networkConnectionLost))
            let retry = try await Self.next(fixture, suffix: "frames")
            #expect(retry.body == first.body)
            #expect(retry.request.url == first.request.url)
            #expect(try retry.frame.id == first.frame.id)
            retry.accept(2)
            let poll = try await Self.next(fixture, suffix: "poll")
            try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
                requestID: first.frame.id, payload: AnyCodable(["runId": "run-one"]), cursor: 2, accepted: 2))
            #expect(try await request.value.ok)
            let resumed = try await Self.next(fixture, suffix: "poll")
            #expect(try resumed.object["ack"] as? Int == 2)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
        }
    }

    @Test(.stateDirectoryIsolated)
    func `scope grant is durable before the poll cursor acknowledges consumption`() async throws {
        try await Self.withFixture { fixture in
            _ = try await Self.connect(fixture)
            let commit = GatewayOperatorHTTPGate()
            defer { commit.release() }
            let request = Task {
                try await fixture.session.request(method: "device.scopes.waitUpgrade") { _, isCurrent in
                    await commit.wait()
                    try #require(isCurrent())
                    try #require(DeviceAuthStore.storeTokenPersisted(
                        deviceId: fixture.identity.deviceId, role: "operator", token: "upgraded-fixture",
                        scopes: ["operator.read", "operator.talk", "operator.write", "operator.approvals"],
                        gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary))
                }
            }
            let frame = try await Self.next(fixture, suffix: "frames")
            frame.accept(2)
            let poll = try await Self.next(fixture, suffix: "poll")
            try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
                requestID: frame.frame.id,
                payload: AnyCodable([
                    "status": "approved", "requestId": "upgrade-one", "deviceToken": "upgraded-fixture",
                    "scopes": ["operator.read", "operator.talk", "operator.write", "operator.approvals"],
                ]),
                cursor: 2, accepted: 2))
            try await commit.waitUntilEntered()
            #expect(fixture.snapshot.last === poll)
            #expect(DeviceAuthStore.loadToken(
                deviceId: fixture.identity.deviceId, role: "operator",
                gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary)?.token
                == GatewayOperatorHTTPFixture.token)
            commit.release()
            _ = try await request.value
            let acknowledged = try await Self.next(fixture, suffix: "poll")
            #expect(try acknowledged.object["ack"] as? Int == 2)
            #expect(DeviceAuthStore.loadToken(
                deviceId: fixture.identity.deviceId, role: "operator",
                gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary)?.token == "upgraded-fixture")
        }
    }

    @Test(.stateDirectoryIsolated)
    func `queued cancellation never sends a mutation or retires the interrupted healthy poll`() async throws {
        try await Self.withFixture { fixture in
            _ = try await Self.connect(fixture)
            await #expect(throws: CancellationError.self) {
                try await GatewayOperatorHTTPFixture.cancelQueuedMutation(on: fixture.session)
            }
            let resumed = try await Self.next(fixture, suffix: "poll")
            #expect(try resumed.object["acceptedClientSeq"] == nil)
            #expect(try resumed.object["ack"] as? Int == 1)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "frames" }.count == 1)
            try await Self.completeRead(fixture, sequence: 2, cursor: 2)
        }
    }

    @Test(.stateDirectoryIsolated)
    func `submitted timeout notifies closure once and reports an unknown result`() async throws {
        try await Self.withFixture { fixture in
            let closed = GatewayOperatorHTTPCloseProbe()
            _ = try await Self.connect(fixture, onClosed: { _ in await closed.record() })
            let mutation = Task {
                try await fixture.session.request(method: "chat.send", timeoutMs: 250, consume: { _, _ in })
            }
            let frame = try await Self.next(fixture, suffix: "frames")
            frame.accept(2)
            _ = try await Self.next(fixture, suffix: "poll")
            do {
                _ = try await mutation.value
                Issue.record("Submitted request completed without a Gateway result")
            } catch let GatewayOperatorHTTPError.resultUnknown(method, requestID) {
                #expect(method == "chat.send")
                #expect(try requestID == frame.frame.id)
            }
            try await closed.wait()
            await fixture.session.disconnect()
            #expect(await closed.count == 1)
            await #expect(throws: GatewayOperatorHTTPError.self) {
                try await fixture.session.request(method: "chat.history", consume: { _, _ in })
            }
            #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
        }
    }

    @Test(.stateDirectoryIsolated, arguments: ["ingress_changed", "connection_closed"])
    func `external retirement does not replay an uncertain write on a replacement connection`(_ code: String)
        async throws
    {
        try await Self.withFixture { fixture in
            let closed = GatewayOperatorHTTPCloseProbe()
            _ = try await Self.connect(fixture, onClosed: { _ in await closed.record() })
            let mutation = Task {
                try await fixture.session.request(method: "approval.resolve", consume: { _, _ in })
            }
            let frame = try await Self.next(fixture, suffix: "frames")
            frame.accept(2)
            let poll = try await Self.next(fixture, suffix: "poll")
            if code == "ingress_changed" {
                try poll.respond(status: 403, body: JSONSerialization.data(withJSONObject: [
                    "error": ["code": code, "message": "Connection retired", "resyncRequired": true],
                ]))
            } else {
                try poll.respond(body: JSONSerialization.data(withJSONObject: [
                    "acceptedClientSeq": 2, "frames": [],
                    "closed": ["code": 4001, "reason": "connection authority changed", "resyncRequired": true],
                ]))
            }
            do {
                _ = try await mutation.value
                Issue.record("Retired connection delivered an approval result")
            } catch let GatewayOperatorHTTPError.resultUnknown(method, requestID) {
                #expect(method == "approval.resolve")
                #expect(try requestID == frame.frame.id)
            }
            try await closed.wait()
            await fixture.session.disconnect()
            #expect(await closed.count == 1)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "frames" }.count == 2)
        }
    }

    @Test(.stateDirectoryIsolated)
    func `disconnect invalidates an awaited consumer before grant persistence or cursor advance`() async throws {
        try await Self.withFixture { fixture in
            _ = try await Self.connect(fixture)
            let commit = GatewayOperatorHTTPGate()
            defer { commit.release() }
            let request = Task {
                try await fixture.session.request(method: "device.scopes.waitUpgrade") { _, isCurrent in
                    await commit.wait()
                    guard isCurrent() else { throw CancellationError() }
                    DeviceAuthStore.storeTokenPersisted(
                        deviceId: fixture.identity.deviceId, role: "operator", token: "must-not-persist",
                        scopes: GatewayOperatorHTTPFixture.scopes,
                        gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary)
                }
            }
            let frame = try await Self.next(fixture, suffix: "frames")
            frame.accept(2)
            let poll = try await Self.next(fixture, suffix: "poll")
            try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
                requestID: frame.frame.id, payload: AnyCodable([String: String]()), cursor: 2, accepted: 2))
            try await commit.waitUntilEntered()
            let disconnect = Task { await fixture.session.disconnect() }
            _ = try await Self.next(fixture, suffix: GatewayOperatorHTTPFixture.connectionID)
            commit.release()
            await disconnect.value
            await #expect(throws: GatewayOperatorHTTPError.self) { try await request.value }
            #expect(DeviceAuthStore.loadToken(
                deviceId: fixture.identity.deviceId, role: "operator",
                gatewayID: GatewayOperatorHTTPFixture.gatewayID, profile: .primary)?.token
                == GatewayOperatorHTTPFixture.token)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "poll" }.count == 3)
        }
    }

    private static func withFixture(
        _ operation: @Sendable (GatewayOperatorHTTPFixture) async throws -> Void) async throws
    {
        let fixture = try GatewayOperatorHTTPFixture()
        do {
            try await operation(fixture)
        } catch {
            await fixture.stop()
            throw error
        }
        await fixture.stop()
    }

    private static func next(_ fixture: GatewayOperatorHTTPFixture, suffix: String)
        async throws -> GatewayOperatorHTTPExchange
    {
        let exchange = try await fixture.next()
        try #require(exchange.request.url?.lastPathComponent == suffix)
        #expect(exchange.request.url?.query == nil)
        if suffix != "connections" {
            #expect(exchange.request.value(forHTTPHeaderField: "Authorization")
                == "Bearer \(GatewayOperatorHTTPFixture.connectionKey)")
            #expect(exchange.request.url?.path.hasPrefix(
                "/team/api/operator/connections/\(GatewayOperatorHTTPFixture.connectionID)") == true)
        }
        return exchange
    }

    private static func connect(
        _ fixture: GatewayOperatorHTTPFixture,
        onClosed: @escaping @Sendable (any Error) async -> Void = { _ in }) async throws -> GatewayOperatorHTTPExchange
    {
        let connecting = fixture.beginConnect(onClosed: onClosed)
        let begin = try await Self.next(fixture, suffix: "connections")
        #expect(begin.request.httpMethod == "POST")
        #expect(begin.request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(try begin.object.isEmpty)
        try begin.respond(status: 201, body: GatewayOperatorHTTPFixture.beginBody())
        let connect = try await Self.next(fixture, suffix: "frames")
        #expect(try connect.object["clientSeq"] as? Int == 1)
        #expect(try connect.object["ack"] as? Int == 0)
        let frame = try connect.frame
        #expect(frame.method == "connect")
        let params = try #require(frame.params?.dictionaryValue)
        #expect(params["auth"]?.dictionaryValue?["deviceToken"]?.stringValue == GatewayOperatorHTTPFixture.token)
        #expect(params["role"]?.stringValue == "operator")
        #expect(params["device"]?.dictionaryValue?["nonce"]?.stringValue == "begin-only-challenge")
        #expect(params["device"]?.dictionaryValue?["id"]?.stringValue == fixture.identity.deviceId)
        #expect(params["device"]?.dictionaryValue?["signature"]?.stringValue?.isEmpty == false)
        connect.accept(1)
        let poll = try await Self.next(fixture, suffix: "poll")
        #expect(try poll.object["ack"] as? Int == 0)
        try poll.respond(body: GatewayOperatorHTTPFixture.hello(requestID: frame.id))
        let hello = try await connecting.value
        #expect(hello.auth["deviceToken"] == nil)
        let idle = try await Self.next(fixture, suffix: "poll")
        #expect(try idle.object["ack"] as? Int == 1)
        #expect(try idle.object["waitMs"] as? Int == 25000)
        return idle
    }

    private static func completeRead(_ fixture: GatewayOperatorHTTPFixture, sequence: Int, cursor: Int) async throws {
        let read = Task {
            try await fixture.session.request(method: "chat.history", consume: { _, _ in })
        }
        let frame = try await Self.next(fixture, suffix: "frames")
        #expect(try frame.frame.method == "chat.history")
        #expect(try frame.object["clientSeq"] as? Int == sequence)
        frame.accept(sequence)
        let poll = try await Self.next(fixture, suffix: "poll")
        try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
            requestID: frame.frame.id, payload: AnyCodable(["messages": [String]()]),
            cursor: cursor, accepted: sequence))
        #expect(try await read.value.ok)
        let idle = try await Self.next(fixture, suffix: "poll")
        #expect(try idle.object["ack"] as? Int == cursor)
    }
}

private actor GatewayOperatorHTTPCloseProbe {
    private let closed = AsyncStream<Void>.makeStream()
    private(set) var count = 0

    func record() {
        self.count += 1
        self.closed.continuation.yield(())
    }

    func wait() async throws {
        try await AsyncTimeout.withTimeout(seconds: 3, onTimeout: { URLError(.timedOut) }) {
            var iterator = self.closed.stream.makeAsyncIterator()
            guard await iterator.next() != nil else { throw CancellationError() }
        }
    }
}
