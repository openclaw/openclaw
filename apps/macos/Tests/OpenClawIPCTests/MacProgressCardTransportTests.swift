import ConcurrencyExtras
import Foundation
import Network
import OpenClawChatUI
import Testing
@testable import OpenClaw

/// Real loopback WebSockets: URLSession and GatewayChannelActor own the client, not a socket mock.
@MainActor
private final class ProgressCardGatewayFixture {
    private let listener: NWListener
    private var connections: [NWConnection] = []
    private(set) var requests: [[String: Any]] = []
    private var peerClosed: Set<ObjectIdentifier> = []
    private let changes = AsyncTestSignal()

    private init(listener: NWListener) {
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] _ in
            MainActor.assumeIsolated { self?.changes.notify() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
    }

    static func start() async throws -> ProgressCardGatewayFixture {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        let fixture = try ProgressCardGatewayFixture(listener: NWListener(using: parameters, on: .any))
        fixture.listener.start(queue: .main)
        try await fixture.changes.wait("progress fixture listener") {
            switch fixture.listener.state {
            case .ready, .failed, .cancelled: true
            default: false
            }
        }
        guard case .ready = fixture.listener.state else { throw URLError(.cannotConnectToHost) }
        return fixture
    }

    var url: URL {
        URL(string: "ws://127.0.0.1:\(self.listener.port!.rawValue)")!
    }

    var cardRequests: [[String: Any]] {
        self.requests.filter { ($0["method"] as? String)?.hasPrefix("progressCard.") == true }
    }

    func waitForPeerClosure() async throws {
        try await self.changes.wait("original loopback sockets closed") {
            self.peerClosed.count == self.connections.count
        }
    }

    func stop() {
        self.listener.cancel()
        for connection in self.connections {
            connection.cancel()
        }
    }

    private func accept(_ connection: NWConnection) {
        self.connections.append(connection)
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard let self else { return }
                switch state {
                case .failed, .cancelled:
                    self.peerClosed.insert(ObjectIdentifier(connection))
                    self.changes.notify()
                    return
                case .ready: break
                default: return
                }
                self.send(GatewayWebSocketTestSupport.connectChallengeData(), on: connection)
                self.receive(connection)
            }
        }
        connection.start(queue: .main)
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                    as? NWProtocolWebSocket.Metadata
                if error != nil || metadata?.opcode == .close || context?.isFinal == true {
                    self.peerClosed.insert(ObjectIdentifier(connection))
                    self.changes.notify()
                    connection.cancel()
                    return
                }
                if let data,
                   let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let id = frame["id"] as? String
                {
                    self.requests.append(frame)
                    let response = frame["method"] as? String == "connect"
                        ? GatewayWebSocketTestSupport.connectOkData(
                            id: id,
                            capabilities: ["progress-card-agent-scope-v1"])
                        : GatewayWebSocketTestSupport.okResponseData(id: id)
                    self.send(response, on: connection)
                    self.changes.notify()
                }
                self.receive(connection)
            }
        }
    }

    private func send(_ data: Data, on connection: NWConnection) {
        let context = NWConnection.ContentContext(
            identifier: "gateway-frame", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }
}

@Suite(.serialized, .testWaitLimit)
struct MacProgressCardTransportTests {
    @Test @MainActor
    func `allowed clear and refresh reach pinned gateway`() async throws {
        try await self.withGateways { a, b, connection, pin, _, _, _ in
            var transport = MacGatewayChatTransport(connection: connection, outboxGatewayID: pin)
            transport._testUsesPrimaryAppRuntime = true
            try await transport.clearProgressCard(sessionKey: "global", agentID: "research", expectedRevision: 3)
            try await transport.refreshProgressCard(
                sessionKey: "global", agentID: "research", idempotencyKey: "refresh-1")
            #expect(a.cardRequests.map { $0["method"] as? String } == ["progressCard.put", "progressCard.refresh"])
            let clear = try #require(a.cardRequests.first?["params"] as? [String: Any])
            #expect(NSDictionary(dictionary: clear).isEqual(to: [
                "sessionKey": "global", "agentId": "research", "expectedRevision": 3,
            ]))
            #expect(a.cardRequests.last?["params"] as? [String: String] == [
                "sessionKey": "global", "agentId": "research", "idempotencyKey": "refresh-1",
            ])
            await connection.shutdown()
            try await a.waitForPeerClosure()
            try await b.waitForPeerClosure()
            #expect(b.cardRequests.isEmpty)
            print(
                "CARD_TRACE allowed A progressCard.put sessionKey=global agentId=research " +
                    "expectedRevision=3; B frames=0")
            print(
                "CARD_TRACE allowed A progressCard.refresh sessionKey=global agentId=research " +
                    "idempotencyKey=refresh-1; B frames=0")
        }
    }

    @Test(arguments: ["clear", "refresh"], ["before-capture", "after-capture", "after-pin-check"])
    @MainActor
    func `replaced gateway rejects card before network IO`(action: String, boundary: String) async throws {
        try await self.withGateways { a, b, connection, pin, source, gate, calls in
            var transport = MacGatewayChatTransport(connection: connection, outboxGatewayID: pin)
            transport._testUsesPrimaryAppRuntime = true
            let replacement = GatewayConnection.EndpointSnapshot(
                config: (url: b.url, token: nil, password: nil), routeAuthority: 2)
            let configPath = try #require(ProcessInfo.processInfo.environment["OPENCLAW_CONFIG_PATH"])
            let replace = {
                try Self.writeConfig(url: b.url, path: configPath)
                source.setEndpoint(replacement)
            }
            if boundary == "before-capture" {
                try replace()
                _ = try await connection.request(method: "health", params: nil)
            }
            calls.withValue { $0 = (0, boundary == "after-capture" ? 3 : boundary == "after-pin-check" ? 4 : nil) }
            let request = Task { @MainActor in
                if action == "clear" {
                    try await transport.clearProgressCard(
                        sessionKey: "global",
                        agentID: "research",
                        expectedRevision: 3)
                } else {
                    try await transport.refreshProgressCard(
                        sessionKey: "global", agentID: "research", idempotencyKey: "refresh-stale")
                }
            }
            var rejectedBeforeDispatch = false
            do {
                if boundary != "before-capture" {
                    // captureRoute + capture's lease validation are calls 1/2. Capability validation is 3;
                    // request's lease validation is 4: real production suspension points, not timing sleeps.
                    await gate.waitUntilStarted()
                    try Task.checkCancellation()
                    #expect(calls.value.0 == (boundary == "after-capture" ? 3 : 4))
                    try replace()
                    await gate.open()
                }
                do {
                    try await TestWait.value(of: request, "card action completion")
                } catch OpenClawChatTransportSendError.notDispatched {
                    rejectedBeforeDispatch = true
                }
                #expect(rejectedBeforeDispatch)
            } catch {
                request.cancel()
                await gate.open()
                _ = await request.result
                throw error
            }
            // Observe termination of the ORIGINAL sockets, not health on a newly configured connection.
            await connection.shutdown()
            try await a.waitForPeerClosure()
            try await b.waitForPeerClosure()
            #expect(a.cardRequests.isEmpty)
            #expect(b.cardRequests.isEmpty)
            print(
                "CARD_TRACE \(action) \(boundary) rejectedBeforeDispatch=\(rejectedBeforeDispatch); " +
                    "A card frames=\(a.cardRequests.count); B card frames=\(b.cardRequests.count); " +
                    "original sockets closed")
        }
    }

    @MainActor
    private static func writeConfig(url: URL, path: String) throws {
        let root: [String: Any] = ["gateway": [
            "mode": "remote",
            "remote": ["transport": "direct", "url": url.absoluteString],
        ]]
        try JSONSerialization.data(withJSONObject: root).write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    @MainActor
    private func withGateways(
        _ body: @MainActor (
            ProgressCardGatewayFixture, ProgressCardGatewayFixture, GatewayConnection, String,
            GatewayConnectionEndpointSource, GatewayConnectionSuspensionGate,
            LockIsolated<(Int, Int?)>) async throws -> Void) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
            let a = try await ProgressCardGatewayFixture.start()
            defer { a.stop() }
            let b = try await ProgressCardGatewayFixture.start()
            defer { b.stop() }
            try Self.writeConfig(url: a.url, path: configPath)
            let pin = try #require(MacChatTranscriptCache.currentGatewayID())
            let source = GatewayConnectionEndpointSource(endpoint: .init(
                config: (url: a.url, token: nil, password: nil), routeAuthority: 1))
            let gate = GatewayConnectionSuspensionGate()
            let calls = LockIsolated<(Int, Int?)>((0, nil))
            let connection = GatewayConnection(testEndpointProvider: {
                let shouldGate = calls.withValue { value in
                    value.0 += 1
                    return value.0 == value.1
                }
                // Model an in-flight endpoint lookup at capability validation; the final request reads
                // the newly published endpoint instead. The identity is always read from the temp config.
                let captured = source.snapshot()
                if shouldGate { await gate.suspend() }
                return shouldGate && calls.value.1 == 4 ? source.snapshot() : captured
            })
            do {
                _ = try await connection.request(method: "health", params: nil)
                try await body(a, b, connection, pin, source, gate, calls)
                await connection.shutdown()
            } catch {
                await gate.open()
                await connection.shutdown()
                throw error
            }
        }
    }
}
