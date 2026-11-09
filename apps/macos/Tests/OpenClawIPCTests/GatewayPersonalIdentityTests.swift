import ConcurrencyExtras
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.gatewayTLSStoreIsolated, .testWaitLimit)
struct GatewayPersonalIdentityTests {
    @Test(arguments: [false, true])
    func `Gateway restart replaces a rejected personal binding through Serve`(automatic: Bool) async throws {
        try await Self.withIdentity {
            let fixture = PersonalIdentityRecoveryFixture()
            let connection = fixture.connection()
            let result: Result<Void, Error>
            do {
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                let oldSocket = try #require(fixture.localSockets.value.last)
                fixture.boot.withValue { $0 = "restarted-gateway" }
                if automatic {
                    oldSocket.emitReceiveFailure()
                    try await fixture.recovered.wait("fresh personal use after automatic reconnect") {
                        fixture.connects.value.last?.gatewayID == "restarted-gateway"
                    }
                } else {
                    oldSocket.state = .completed
                }
                let data = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                let payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
                #expect(payload["boot"] == "restarted-gateway")
                let binds = fixture.connects.value.filter { $0.phase == "bind" }
                let uses = fixture.connects.value.filter { $0.phase == "use" }
                #expect(binds.count == 2)
                #expect(uses.map(\.gatewayID) == ["original-gateway", "original-gateway", "restarted-gateway"])
                #expect(uses.last?.bindingID == binds.last?.bindingID)
                #expect(binds.first?.bindingID != binds.last?.bindingID)
                #expect(Set(fixture.connects.value.map(\.deviceID)).count == 1)
                #expect(fixture.connects.value.allSatisfy {
                    $0.scopes == GatewayChannelActor.defaultOperatorConnectScopes
                })
                #expect(binds.allSatisfy { $0.token == nil })
                #expect(uses.allSatisfy { $0.token == "synthetic-personal-token" })
                #expect(oldSocket.snapshotCancelCount() > 0)
                result = .success(())
            } catch { result = .failure(error) }
            await connection.shutdown()
            try result.get()
        }
    }

    @Test func `a delayed personal rebind cannot replace a superseding route`() async throws {
        try await Self.withIdentity {
            let fixture = PersonalIdentityRecoveryFixture(holdsSecondBind: true)
            let connection = fixture.connection()
            var pendingRequest: Task<Data, Error>?
            let result: Result<Void, Error>
            do {
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                let oldSocket = try #require(fixture.localSockets.value.last)
                fixture.boot.withValue { $0 = "restarted-gateway" }
                oldSocket.state = .completed
                let request = Task {
                    try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                }
                pendingRequest = request
                try await fixture.secondBindStarted.wait("recovery Serve bind") {
                    fixture.connects.value.filter { $0.phase == "bind" }.count == 2
                }
                fixture.revision.withValue { $0 = 2 }
                try await connection.refresh()
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                fixture.releaseSecondBind.open()
                do {
                    _ = try await request.value
                    Issue.record("Superseded rebind dispatched a request")
                } catch { #expect(error is CancellationError) }
                let binds = fixture.connects.value.filter { $0.phase == "bind" }
                let uses = fixture.connects.value.filter { $0.phase == "use" }
                #expect(binds.count == 3)
                #expect(uses.last?.bindingID == binds.last?.bindingID)
                #expect(!uses.contains { $0.bindingID == binds[1].bindingID })
                #expect(uses.last?.token == "synthetic-replacement-token")
                result = .success(())
            } catch { result = .failure(error) }
            fixture.releaseSecondBind.open()
            pendingRequest?.cancel()
            _ = await pendingRequest?.result
            await connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [false, true])
    func `superseded personal discovery sends no stale Serve bind`(disablePersonal: Bool) async throws {
        try await Self.withIdentity {
            let fixture = PersonalIdentityRecoveryFixture(holdsSecondDiscovery: true)
            let connection = fixture.connection()
            var pendingRequest: Task<Data, Error>?
            let result: Result<Void, Error>
            do {
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                let oldSocket = try #require(fixture.localSockets.value.last)
                fixture.boot.withValue { $0 = "restarted-gateway" }
                oldSocket.state = .completed
                let request = Task {
                    try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                }
                pendingRequest = request
                try await fixture.secondDiscoveryStarted.wait("recovery Serve discovery") {
                    fixture.discoveries.value == 2
                }
                if disablePersonal {
                    fixture.personalEnabled.withValue { $0 = false }
                } else {
                    fixture.revision.withValue { $0 = 2 }
                }
                fixture.releaseSecondDiscovery.open()
                do {
                    _ = try await request.value
                    Issue.record("Superseded discovery dispatched a request")
                } catch { #expect(error is CancellationError) }
                #expect(fixture.connects.value.filter { $0.phase == "bind" }.count == 1)
                #expect(!fixture.connects.value.contains { $0.gatewayID == "restarted-gateway" })
                result = .success(())
            } catch { result = .failure(error) }
            fixture.releaseSecondDiscovery.open()
            pendingRequest?.cancel()
            _ = await pendingRequest?.result
            await connection.shutdown()
            try result.get()
        }
    }

    private static func withIdentity(
        isolation: isolated (any Actor)? = #isolation,
        _ operation: () async throws -> Void) async throws
    {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await DeviceIdentityStore.withStateDirectory(directory, operation: operation)
    }

    @Test func `local route pins the Gateway certificate attested inside Serve binding`() throws {
        let localGatewayFingerprint = Self.fingerprint(byte: "a1")
        let differentServeCertificate = Self.fingerprint(byte: "b2")
        let localURL = try #require(URL(string: "wss://127.0.0.1:18789"))

        let route = try #require(GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: localURL,
            gatewayFingerprint: localGatewayFingerprint))

        #expect(route.params.expectedFingerprint == localGatewayFingerprint)
        #expect(route.params.expectedFingerprint != differentServeCertificate)
        #expect(route.params.allowTOFU == false)
        #expect(route.allowsTrustedPinReplacement == false)
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: localGatewayFingerprint,
            observedFingerprint: localGatewayFingerprint,
            allowTOFU: route.params.allowTOFU,
            required: route.params.required,
            systemTrustOk: true) == .accept(
            fingerprint: localGatewayFingerprint,
            enforcePin: true,
            saveFirstUse: false))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: localGatewayFingerprint,
            observedFingerprint: differentServeCertificate,
            allowTOFU: route.params.allowTOFU,
            required: route.params.required,
            systemTrustOk: true) == .reject(.pinMismatch))
    }

    @Test func `personal local route rejects plaintext and nonlocal listeners`() throws {
        let fingerprint = Self.fingerprint(byte: "c3")
        #expect(try GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            gatewayFingerprint: fingerprint) == nil)
        #expect(try GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: #require(URL(string: "wss://gateway.example.ts.net")),
            gatewayFingerprint: fingerprint) == nil)
        #expect(try GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: #require(URL(string: "wss://127.0.0.1:18789")),
            gatewayFingerprint: "not-a-fingerprint") == nil)
        #expect(try GatewayConnection.primaryPersonalIdentityTLSRoute(
            url: #require(URL(string: "wss://127.0.0.1:18789")),
            gatewayFingerprint: Array(repeating: "c3", count: 32).joined(separator: ":")) == nil)
    }

    @Test func `bound boot id must match local Primary Gateway hello`() {
        let server = ["bootId": OpenClawProtocol.AnyCodable("bound-gateway")]
        #expect(GatewayChannelActor.matchesExpectedGateway(server: server, expectedGatewayId: "bound-gateway"))
        #expect(!GatewayChannelActor.matchesExpectedGateway(server: server, expectedGatewayId: "other-gateway"))
        #expect(!GatewayChannelActor.matchesExpectedGateway(server: [:], expectedGatewayId: "bound-gateway"))
    }

    private static func fingerprint(byte: String) -> String {
        Array(repeating: byte, count: 32).joined()
    }
}

private final class PersonalIdentityRecoverySession: WebSocketSessioning, GatewayTLSRouteMetadataProviding,
    @unchecked Sendable
{
    let effectiveTLSFingerprintSHA256: String? = String(repeating: "b2", count: 32)
    let transport: GatewayTestWebSocketSession

    init(transport: GatewayTestWebSocketSession) {
        self.transport = transport
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.transport.makeWebSocketTask(url: url)
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.transport.makeWebSocketTask(request: request)
    }
}

private final class PersonalIdentityRecoveryFixture: @unchecked Sendable {
    struct Connect: Sendable {
        let phase: String
        let bindingID: String
        let gatewayID: String?
        let deviceID: String
        let scopes: [String]
        let token: String?
    }

    let boot = LockIsolated("original-gateway")
    let revision = LockIsolated<UInt64>(1)
    let personalEnabled = LockIsolated(true)
    let discoveries = LockIsolated(0)
    let connects = LockIsolated<[Connect]>([])
    let localSockets = LockIsolated<[GatewayTestWebSocketTask]>([])
    let recovered = AsyncTestSignal()
    let secondBindStarted = AsyncTestSignal()
    let releaseSecondBind = AsyncTestGate()
    let secondDiscoveryStarted = AsyncTestSignal()
    let releaseSecondDiscovery = AsyncTestGate()
    let holdsSecondBind: Bool
    let holdsSecondDiscovery: Bool
    let localURL = URL(string: "wss://127.0.0.1:18789")!
    let serveURL = URL(string: "wss://personal-fixture.example.ts.net")!
    let fingerprint = String(repeating: "a1", count: 32)

    init(holdsSecondBind: Bool = false, holdsSecondDiscovery: Bool = false) {
        self.holdsSecondBind = holdsSecondBind
        self.holdsSecondDiscovery = holdsSecondDiscovery
    }

    func endpoint() -> GatewayConnection.EndpointSnapshot {
        GatewayConnection.EndpointSnapshot(
            config: (
                self.localURL,
                self.revision.value == 1 ? "synthetic-personal-token" : "synthetic-replacement-token",
                nil),
            tls: GatewayConnection.primaryPersonalIdentityTLSRoute(
                url: self.localURL, gatewayFingerprint: self.fingerprint),
            enablesPrimaryPersonalIdentity: self.personalEnabled.value,
            routeAuthority: self.revision.value,
            deviceAuthGatewayID: "synthetic-personal-owner",
            revision: self.revision.value)
    }

    func connection() -> GatewayConnection {
        GatewayConnection(
            endpointProvider: { self.endpoint() },
            supportsSharedEndpointRecovery: false,
            activationBindingKeyProvider: { nil },
            sessionProvider: { route in route.map { self.session(route: $0) } },
            personalIdentityServeURLProvider: {
                let index = self.discoveries.withValue { $0 += 1
                    return $0
                }
                if index == 2 {
                    self.secondDiscoveryStarted.notify()
                    if self.holdsSecondDiscovery { await self.releaseSecondDiscovery.wait() }
                }
                return self.serveURL
            })
    }

    func session(route: GatewayTLSRoute) -> WebSocketSessionBox {
        #expect(route.params.required)
        let isLocal = route.params.storeKey == GatewayTLSRoute.storeKey(for: self.localURL)
        if isLocal {
            #expect(!route.params.allowTOFU)
            #expect(route.params.expectedFingerprint == self.fingerprint)
        }
        let transport = GatewayTestWebSocketSession(taskFactory: {
            let connect = LockIsolated<Connect?>(nil)
            let socket = GatewayTestWebSocketTask(sendHook: { socket, message, index in
                if index == 0 {
                    let params = try #require(GatewayWebSocketTestSupport.connectRequestParams(from: message))
                    let intent = try #require(params["personalIdentity"] as? [String: Any])
                    let device = try #require(params["device"] as? [String: Any])
                    let wire = try Connect(
                        phase: #require(intent["phase"] as? String),
                        bindingID: #require(intent["bindingId"] as? String),
                        gatewayID: intent["gatewayId"] as? String,
                        deviceID: #require(device["id"] as? String),
                        scopes: #require(params["scopes"] as? [String]),
                        token: (params["auth"] as? [String: Any])?["token"] as? String)
                    connect.withValue { $0 = wire }
                    self.connects.withValue { $0.append(wire) }
                } else {
                    let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(
                        id: id, payload: "{\"boot\":\"\(self.boot.value)\"}")))
                }
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let wire = try #require(connect.value)
                let id = socket.snapshotConnectRequestID() ?? "connect"
                if wire.phase == "use", wire.gatewayID != self.boot.value {
                    return try .data(GatewayWebSocketTestSupport.errorResponseData(
                        id: id,
                        code: "UNAVAILABLE",
                        message: "Authenticated profile unavailable",
                        details: ["code": "AUTHENTICATED_PROFILE_UNAVAILABLE"]))
                }
                if wire.phase == "bind", self.connects.value.filter({ $0.phase == "bind" }).count == 2 {
                    self.secondBindStarted.notify()
                    if self.holdsSecondBind { await self.releaseSecondBind.wait() }
                }
                var frame = try #require(JSONSerialization.jsonObject(with:
                    GatewayWebSocketTestSupport.connectOkData(id: id)) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                payload["server"] = ["version": "test", "connId": "test", "bootId": self.boot.value]
                if wire.phase == "bind" {
                    payload["personalIdentityBinding"] = [
                        "mode": "personal-identity", "provider": "tailscale", "bindingId": wire.bindingID,
                        "profileId": "synthetic-profile", "gatewayId": self.boot.value,
                        "tlsFingerprint": self.fingerprint,
                    ]
                } else if wire.gatewayID == "restarted-gateway" {
                    self.recovered.notify()
                }
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
            if isLocal { self.localSockets.withValue { $0.append(socket) } }
            return socket
        })
        return WebSocketSessionBox(session: PersonalIdentityRecoverySession(transport: transport))
    }
}
