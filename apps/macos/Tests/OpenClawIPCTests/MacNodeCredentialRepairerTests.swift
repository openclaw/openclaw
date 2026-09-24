import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private final class MacNodeCredentialRepairRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var rotateRequests: [[String: Any]] = []

    func record(_ message: URLSessionWebSocketTask.Message) {
        let data: Data? = switch message {
        case let .data(value): value
        case let .string(value): Data(value.utf8)
        @unknown default: nil
        }
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["method"] as? String == "device.token.rotate",
              let params = object["params"] as? [String: Any]
        else { return }
        self.lock.withLock {
            self.rotateRequests.append(params)
        }
    }

    func requests() -> [[String: Any]] {
        self.lock.withLock { self.rotateRequests }
    }
}

private final class MacNodeCredentialRepairPayload: @unchecked Sendable {
    let value: [String: Any]

    init(_ value: [String: Any]) {
        self.value = value
    }
}

private final class MacNodeCredentialRepairRevision: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64

    init(_ value: UInt64) {
        self.value = value
    }

    func load() -> UInt64 {
        self.lock.withLock { self.value }
    }

    func store(_ value: UInt64) {
        self.lock.withLock { self.value = value }
    }
}

@Suite(.serialized)
struct MacNodeCredentialRepairerTests {
    @Test @MainActor
    func `missing scoped node credential is reissued without claiming the legacy token`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let identity = DeviceIdentityStore.loadOrCreate(profile: .primary)
            let gatewayID = "gateway-secretref-upgrade"
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: (
                    url: #require(URL(string: "wss://gateway.example.invalid")),
                    token: nil,
                    password: nil),
                routeAuthority: 9,
                deviceAuthGatewayID: gatewayID,
                revision: 12)
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "operator",
                token: "operator-device-token",
                gatewayID: gatewayID))
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "node",
                token: "legacy-unscoped-node-token"))

            let recorder = MacNodeCredentialRepairRequestRecorder()
            let connection = self.makeConnection(
                endpoint: endpoint,
                recorder: recorder,
                rotatePayload: [
                    "deviceId": identity.deviceId,
                    "role": "node",
                    "token": "replacement-scoped-node-token",
                    "scopes": [],
                    "rotatedAtMs": 1_725_000_000_000,
                ])
            do {
                _ = try await connection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                let outcome = try await MacNodeCredentialRepairer(gateway: connection).repair(
                    endpoint: endpoint,
                    nodeIdentityProfile: .primary)

                #expect(outcome == .repaired)
                #expect(DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    gatewayID: gatewayID)?.token == "replacement-scoped-node-token")
                #expect(DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "node")?.token == "legacy-unscoped-node-token")
                let reconnectOutcome = try await MacNodeCredentialRepairer(gateway: connection).repair(
                    endpoint: endpoint,
                    nodeIdentityProfile: .primary)
                #expect(reconnectOutcome == .alreadyAvailable)
                let request = try #require(recorder.requests().only)
                #expect(request["deviceId"] as? String == identity.deviceId)
                #expect(request["role"] as? String == "node")
                #expect((request["scopes"] as? [Any])?.isEmpty == true)
            } catch {
                await connection.shutdown()
                throw error
            }
            await connection.shutdown()
        }
    }

    @Test @MainActor
    func `distinct node identity is not rotated through the operator device`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let operatorIdentity = DeviceIdentityStore.loadOrCreate(profile: .primary)
            let nodeIdentity = DeviceIdentityStore.loadOrCreate(profile: .node)
            let gatewayID = "gateway-distinct-node"
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: (
                    url: #require(URL(string: "wss://gateway.example.invalid")),
                    token: nil,
                    password: nil),
                routeAuthority: 10,
                deviceAuthGatewayID: gatewayID,
                revision: 13)
            #expect(operatorIdentity.deviceId != nodeIdentity.deviceId)
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: operatorIdentity.deviceId,
                role: "operator",
                token: "operator-device-token",
                gatewayID: gatewayID))

            let recorder = MacNodeCredentialRepairRequestRecorder()
            let connection = self.makeConnection(
                endpoint: endpoint,
                recorder: recorder,
                rotatePayload: [:])
            do {
                _ = try await connection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                await #expect(throws: MacNodeCredentialRepairError.self) {
                    try await MacNodeCredentialRepairer(gateway: connection).repair(
                        endpoint: endpoint,
                        nodeIdentityProfile: .node)
                }
                #expect(recorder.requests().isEmpty)
                #expect(DeviceAuthStore.loadToken(
                    deviceId: nodeIdentity.deviceId,
                    role: "node",
                    gatewayID: gatewayID,
                    profile: .node) == nil)
            } catch {
                await connection.shutdown()
                throw error
            }
            await connection.shutdown()
        }
    }

    @Test @MainActor
    func `withheld rotation response is not persisted`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let identity = DeviceIdentityStore.loadOrCreate(profile: .primary)
            let gatewayID = "gateway-withheld-node-token"
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: (
                    url: #require(URL(string: "wss://gateway.example.invalid")),
                    token: nil,
                    password: nil),
                routeAuthority: 11,
                deviceAuthGatewayID: gatewayID,
                revision: 14)
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "operator",
                token: "operator-device-token",
                gatewayID: gatewayID))

            let recorder = MacNodeCredentialRepairRequestRecorder()
            let connection = self.makeConnection(
                endpoint: endpoint,
                recorder: recorder,
                rotatePayload: [
                    "deviceId": identity.deviceId,
                    "role": "node",
                    "scopes": [],
                    "rotatedAtMs": 1_725_000_000_000,
                    "tokenDelivery": "withheld-cross-device",
                ])
            do {
                _ = try await connection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                await #expect(throws: MacNodeCredentialRepairError.self) {
                    try await MacNodeCredentialRepairer(gateway: connection).repair(
                        endpoint: endpoint,
                        nodeIdentityProfile: .primary)
                }
                #expect(recorder.requests().count == 1)
                #expect(DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    gatewayID: gatewayID) == nil)
            } catch {
                await connection.shutdown()
                throw error
            }
            await connection.shutdown()
        }
    }

    @Test @MainActor
    func `late rotation result is not persisted after endpoint replacement`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let identity = DeviceIdentityStore.loadOrCreate(profile: .primary)
            let gatewayID = "gateway-replaced-route"
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: (
                    url: #require(URL(string: "wss://gateway.example.invalid")),
                    token: nil,
                    password: nil),
                routeAuthority: 12,
                deviceAuthGatewayID: gatewayID,
                revision: 15)
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "operator",
                token: "operator-device-token",
                gatewayID: gatewayID))

            let revision = MacNodeCredentialRepairRevision(15)
            let recorder = MacNodeCredentialRepairRequestRecorder()
            let connection = self.makeConnection(
                endpoint: endpoint,
                recorder: recorder,
                rotatePayload: [
                    "deviceId": identity.deviceId,
                    "role": "node",
                    "token": "late-node-token",
                    "scopes": [],
                    "rotatedAtMs": 1_725_000_000_000,
                ],
                currentEndpointRevision: { revision.load() })
            do {
                _ = try await connection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                let rotation = try await connection.rotateOwnNodeToken(
                    deviceID: identity.deviceId,
                    ifCurrentEndpoint: endpoint)
                revision.store(16)

                await #expect(throws: MacNodeCredentialRepairError.self) {
                    try await connection.persistOwnNodeToken(
                        from: rotation,
                        deviceID: identity.deviceId,
                        gatewayID: gatewayID,
                        profile: .primary,
                        ifCurrentEndpoint: endpoint)
                }
                #expect(DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId,
                    role: "node",
                    gatewayID: gatewayID) == nil)
            } catch {
                await connection.shutdown()
                throw error
            }
            await connection.shutdown()
        }
    }

    private func makeConnection(
        endpoint: GatewayConnection.EndpointSnapshot,
        recorder: MacNodeCredentialRepairRequestRecorder,
        rotatePayload: [String: Any],
        currentEndpointRevision: (@Sendable () -> UInt64)? = nil) -> GatewayConnection
    {
        let payload = MacNodeCredentialRepairPayload(rotatePayload)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                recorder.record(message)
                if GatewayWebSocketTestSupport.requestMethod(from: message) == "device.token.rotate" {
                    let response = try JSONSerialization.data(withJSONObject: [
                        "type": "res",
                        "id": id,
                        "ok": true,
                        "payload": payload.value,
                    ])
                    task.emitReceiveSuccess(.data(response))
                } else {
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            }, receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
            })
        })
        return GatewayConnection(
            endpointProvider: { endpoint },
            currentEndpointRevision: currentEndpointRevision ?? { endpoint.revision ?? 0 },
            supportsSharedEndpointRecovery: false,
            activationBindingKeyProvider: { nil },
            sessionBox: WebSocketSessionBox(session: session))
    }
}

extension Collection {
    fileprivate var only: Element? {
        self.count == 1 ? self.first : nil
    }
}
