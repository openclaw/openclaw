import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private func makeControlUIAuthSession(
    issuedDeviceToken: String? = nil,
    scopes: [String] = [],
    method: String? = nil,
    rejectFirstSharedToken: Bool = false,
    reconnectGrant: (token: String, scopes: [String])? = nil,
    beforeReconnectChallenge: (@Sendable () async -> Void)? = nil) -> GatewayTestWebSocketSession
{
    let attempts = LockIsolated(0)
    return GatewayTestWebSocketSession(taskFactory: {
        let attempt = attempts.withValue { count in
            defer { count += 1 }
            return count
        }
        return GatewayTestWebSocketTask(
            sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    if attempt > 0 { await beforeReconnectChallenge?() }
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                if rejectFirstSharedToken, attempt == 0 {
                    return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                        id: id,
                        detailCode: GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
                        canRetryWithDeviceToken: true,
                        recommendedNextStep: GatewayConnectRecoveryNextStep.retryWithDeviceToken.rawValue))
                }
                let data = GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    deviceToken: attempt > 0 ? reconnectGrant?.token ?? issuedDeviceToken : issuedDeviceToken,
                    scopes: attempt > 0 ? reconnectGrant?.scopes ?? scopes : scopes)
                guard let method else { return .data(data) }
                var response = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                var payload = try #require(response["payload"] as? [String: Any])
                var auth = try #require(payload["auth"] as? [String: Any])
                auth["method"] = method
                payload["auth"] = auth
                response["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: response))
            })
    })
}

private func controlUIRoute(
    _ rawURL: String, token: String? = nil, password: String? = nil) throws -> GatewayConnection.Config
{
    try (
        url: #require(URL(string: rawURL)),
        token: token,
        password: password)
}

private func withControlUIConnection(
    _ connection: GatewayConnection,
    operation: () async throws -> Void) async rethrows
{
    do {
        try await operation()
    } catch {
        await connection.shutdown()
        throw error
    }
    await connection.shutdown()
}

@Suite(.serialized, .testWaitLimit)
struct GatewayConnectionControlUIAuthTests {
    @Test(arguments: ["token", "password", "device-token"])
    @MainActor
    func `same dashboard provider refuses disconnected authority and follows the native reconnect`(
        method: String) async throws
    {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let defaultsName = "DashboardReconnectTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let gatewayID = "native-reconnect"
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "initial-device-grant",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                gatewayID: gatewayID)
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: controlUIRoute(
                    "ws://native-reconnect.invalid",
                    token: method == "token" ? "accepted-token" : nil,
                    password: method == "password" ? "accepted-password" : nil),
                routeAuthority: 1,
                deviceAuthGatewayID: gatewayID,
                revision: 1)
            let source = GatewayConnectionEndpointSource(endpoint: endpoint)
            let reconnectGate = GatewayConnectionSuspensionGate()
            let reconnectChallenges = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
            let session = makeControlUIAuthSession(
                scopes: ["operator.read"],
                method: method,
                reconnectGrant: ("reconnected-device-grant", ["operator.read", "operator.write"]),
                beforeReconnectChallenge: {
                    reconnectChallenges.continuation.yield(())
                    await reconnectGate.suspend()
                })
            let connection = GatewayConnection(
                endpointProvider: { source.snapshot() },
                currentEndpointRevision: { source.snapshot().revision ?? 0 },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: session))
            let manager = DashboardManager._testMake(
                selection: MacGatewaySelectionPreferences(defaults: defaults),
                connectionProvider: { _ in connection },
                browserIdentityURLProvider: nil,
                legacyCredentialsProvider: nil,
                automaticGatewayProfileRefreshEnabled: false)
            let result: Result<Void, Error>
            do {
                // Remote configuration discovers SSO through the existing native
                // request owner, which also makes a fresh native route ready.
                #expect(session.snapshotMakeCount() == 0)
                let configuration = try await manager.dashboardConfiguration(
                    endpoint: endpoint, mode: .remote, target: .profile("reconnect"), token: nil).configuration
                let expectedLegacy = switch method {
                case "token": ["token": "accepted-token"]
                case "password": ["password": "accepted-password"]
                default: [String: String]()
                }
                let credentials: [String: String]? = if case let .nativeDevice(_, _, _, credentials) = configuration
                    .auth
                {
                    credentials
                } else {
                    nil
                }
                #expect(credentials == expectedLegacy)
                let provider = try #require(configuration.nativeAuthProvider)
                let originalLease = try #require(await connection.captureServerLease())
                let original = try await provider("original-challenge", 123)
                #expect(original.isCurrent())
                #expect(session.snapshotMakeCount() == 1)
                let deliveries = await connection.subscribe()
                let socket = try #require(session.latestTask())
                socket.emitReceiveFailure()
                var challenge = reconnectChallenges.stream.makeAsyncIterator()
                guard await challenge.next() != nil, !Task.isCancelled else {
                    Issue.record("Still waiting for reconnect challenge")
                    throw CancellationError()
                }
                // The replacement physical socket is waiting for its challenge,
                // so no old hello or prepared reply can authorize the web view.
                #expect(!original.isCurrent())
                #expect(await connection.captureServerLease() == nil)
                await #expect(throws: CancellationError.self) {
                    try await provider("disconnected-challenge", 124)
                }
                // The replacement hello issues the renewed grant through the
                // channel's normal persistence path, not a test-side store write.
                await reconnectGate.open()
                var successor: GatewayConnection.ServerLease?
                for await delivery in deliveries {
                    if case .snapshot = delivery.push, delivery.isCurrent,
                       delivery.serverLease != originalLease
                    {
                        successor = delivery.serverLease
                        break
                    }
                }
                guard let replacementLease = successor, !Task.isCancelled else {
                    Issue.record("Still waiting for native reconnect lease")
                    throw CancellationError()
                }
                #expect(replacementLease.socketGeneration != originalLease.socketGeneration)
                let reconnected = try await provider("replacement-challenge", 125)
                let value = try #require(JSONSerialization.jsonObject(with: reconnected.json) as? [String: Any])
                let device = try #require(value["device"] as? [String: Any])
                let expectedAuth = switch method {
                case "token": ["token": "accepted-token"]
                case "password": ["password": "accepted-password"]
                default: ["deviceToken": "reconnected-device-grant"]
                }
                #expect(value["auth"] as? [String: String] == expectedAuth)
                #expect(value["scopes"] as? [String] == ["operator.read", "operator.write"])
                #expect(device["id"] as? String == identity.deviceId)
                #expect(device["nonce"] as? String == "replacement-challenge")
                #expect(device["signedAt"] as? Int == 125)
                #expect(reconnected.isCurrent())
                #expect(!original.isCurrent())
                #expect(session.snapshotMakeCount() == 2)
                // Reconnect may refresh a physical lease, never the dashboard's
                // fixed route authority, even when the address stays the same.
                source.setEndpoint(.init(
                    config: endpoint.config, routeAuthority: 2, deviceAuthGatewayID: gatewayID, revision: 2))
                #expect(!reconnected.isCurrent())
                await #expect(throws: CancellationError.self) {
                    try await provider("retargeted-challenge", 126)
                }
                result = .success(())
            } catch {
                result = .failure(error)
            }
            reconnectChallenges.continuation.finish()
            await reconnectGate.open()
            manager.close()
            await connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: ["token", "password", "legacy-token", "legacy-password"])
    func `native dashboard preserves accepted shared auth and retires with the exact socket`(
        method: String) async throws
    {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let usesPassword = method.hasSuffix("password")
            let route = try controlUIRoute(
                "ws://native-dashboard.invalid",
                token: usesPassword ? nil : "shared-token",
                password: usesPassword ? "shared-password" : nil)
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: route, routeAuthority: 7, deviceAuthGatewayID: "native-dashboard", revision: 1)
            let source = GatewayConnectionEndpointSource(endpoint: endpoint)
            let connection = GatewayConnection(
                endpointProvider: { source.snapshot() },
                currentEndpointRevision: { source.snapshot().revision ?? 0 },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    issuedDeviceToken: "current-native-token",
                    scopes: ["operator.read"],
                    method: method.hasPrefix("legacy-") ? nil : method)))
            try await withControlUIConnection(connection) {
                #expect(await connection.captureServerLease() == nil)
                let legacy = try await connection.controlUiLegacyCredentials(endpoint: endpoint)
                #expect(legacy.credentials ==
                    [usesPassword ? "password" : "token": usesPassword ? "shared-password" : "shared-token"])
                #expect(await connection.captureServerLease() != nil)
                let signed = try await connection.controlUiNativeAuth(
                    endpoint: endpoint,
                    nonce: "web-nonce",
                    signedAt: 123)
                let value = try #require(JSONSerialization.jsonObject(with: signed.json) as? [String: Any])
                let device = try #require(value["device"] as? [String: Any])
                #expect(device["id"] as? String == DeviceIdentityStore.loadOrCreate().deviceId)
                #expect(device["nonce"] as? String == "web-nonce")
                #expect(value["scopes"] as? [String] == ["operator.read"])
                #expect((value["auth"] as? [String: String]) ==
                    [usesPassword ? "password" : "token": usesPassword ? "shared-password" : "shared-token"])
                #expect(signed.isCurrent())

                source.setEndpoint(.init(config: route, routeAuthority: 8, deviceAuthGatewayID: "other", revision: 2))
                #expect(!signed.isCurrent())
                #expect(!legacy.isCurrent())
                await #expect(throws: CancellationError.self) {
                    try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "other-nonce", signedAt: 124)
                }
                await #expect(throws: CancellationError.self) {
                    try await connection.controlUiLegacyCredentials(endpoint: endpoint)
                }
                let rotated = GatewayConnection.EndpointSnapshot(
                    config: (route.url, usesPassword ? nil : "rotated-token", usesPassword ? "rotated-password" : nil),
                    routeAuthority: 9, deviceAuthGatewayID: "native-dashboard", revision: 3)
                source.setEndpoint(rotated)
                #expect(try await connection.controlUiLegacyCredentials(endpoint: rotated).credentials ==
                    [usesPassword ? "password" : "token": usesPassword ? "rotated-password" : "rotated-token"])
            }
        }
    }

    @Test(arguments: ["device-token", "legacy-device-token", "rejected-shared"])
    func `stored native grant survives omitted hello token but not rotation revocation or identity replacement`(
        method: String) async throws
    {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let gatewayID = "native-stored-grant"
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "stored-native-token",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                gatewayID: gatewayID)
            let retry = method == "rejected-shared"
            // Loopback is a trusted retry route; the injected session owns every
            // socket and never opens a real transport.
            let route = try controlUIRoute("ws://127.0.0.1:19200", token: retry ? "rejected-shared-token" : nil)
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: route, routeAuthority: 1, deviceAuthGatewayID: gatewayID, revision: 1)
            let connection = GatewayConnection(
                endpointProvider: { endpoint },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    scopes: ["operator.read"],
                    method: method == "device-token" ? method : nil,
                    rejectFirstSharedToken: retry)))
            try await withControlUIConnection(connection) {
                if retry {
                    await #expect(throws: GatewayConnectAuthError.self) {
                        try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                    }
                }
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                #expect(await connection.authSource() == .deviceToken)
                #expect(try await connection.controlUiLegacyCredentials(endpoint: endpoint).credentials.isEmpty)
                let lease = try #require(await connection.captureServerLease())
                let signed = try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "nonce", signedAt: 123)
                let value = try #require(JSONSerialization.jsonObject(with: signed.json) as? [String: Any])
                #expect(value["auth"] as? [String: String] == ["deviceToken": "stored-native-token"])
                #expect(value["scopes"] as? [String] == ["operator.read"])
                #expect(signed.isCurrent())

                let replacementState = stateDir.appendingPathComponent("replacement-identity", isDirectory: true)
                try FileManager.default.createDirectory(at: replacementState, withIntermediateDirectories: true)
                await DeviceIdentityStore.withStateDirectory(replacementState) {
                    let replacement = DeviceIdentityStore.loadOrCreate()
                    #expect(replacement.deviceId != identity.deviceId)
                    _ = DeviceAuthStore.storeToken(
                        deviceId: replacement.deviceId,
                        role: "operator",
                        token: "different-identity-token",
                        gatewayID: gatewayID)
                    #expect(!signed.isCurrent())
                    await #expect(throws: CancellationError.self) {
                        try await connection.controlUiNativeAuth(
                            endpoint: endpoint,
                            nonce: "replacement",
                            signedAt: 124)
                    }
                }
                #expect(signed.isCurrent())
                _ = DeviceAuthStore.storeToken(
                    deviceId: identity.deviceId, role: "operator", token: "rotated-native-token", gatewayID: gatewayID)
                #expect(!signed.isCurrent())
                let rotated = try await connection.controlUiNativeAuth(
                    endpoint: endpoint,
                    nonce: "rotated",
                    signedAt: 125)
                let rotatedValue = try #require(JSONSerialization.jsonObject(with: rotated.json) as? [String: Any])
                #expect(rotatedValue["auth"] as? [String: String] == ["deviceToken": "rotated-native-token"])
                #expect(rotated.isCurrent())
                #expect(await connection.isCurrentServerLease(lease))

                DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)
                _ = DeviceAuthStore.storeToken(
                    deviceId: identity.deviceId, role: "operator", token: "unscoped-token")
                _ = DeviceAuthStore.storeToken(
                    deviceId: identity.deviceId, role: "operator", token: "other-gateway-token", gatewayID: "other")
                #expect(!rotated.isCurrent())
                await #expect(throws: CancellationError.self) {
                    try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "revoked", signedAt: 126)
                }
            }
        }
    }

    @Test(arguments: ["token", "password"])
    func `device retry cannot lend rejected configured credentials even when hello names shared auth`(
        method: String) async throws
    {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "stored-native-token",
                scopes: GatewayChannelActor.defaultOperatorConnectScopes,
                gatewayID: "retry")
            let route = try controlUIRoute(
                "ws://127.0.0.1:19200", token: "rejected-token", password: "unselected-password")
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: route,
                routeAuthority: 1,
                deviceAuthGatewayID: "retry")
            let connection = GatewayConnection(
                endpointProvider: { endpoint },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    scopes: ["operator.read"], method: method, rejectFirstSharedToken: true)))
            try await withControlUIConnection(connection) {
                await #expect(throws: GatewayConnectAuthError.self) {
                    try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                }
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                #expect(await connection.authSource() == .deviceToken)
                #expect(try await connection.controlUiLegacyCredentials(endpoint: endpoint).credentials.isEmpty)
                await #expect(throws: CancellationError.self) {
                    try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "nonce", signedAt: 123)
                }
            }
        }
    }

    @Test(arguments: ["bootstrap-token", "tailscale", "trusted-proxy", "none"], [true, false])
    func `nonshared accepted native auth needs a scoped issued grant`(method: String, hasGrant: Bool) async throws {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let endpoint = try GatewayConnection.EndpointSnapshot(
                config: controlUIRoute("ws://nonshared.invalid"), routeAuthority: 1, deviceAuthGatewayID: "nonshared")
            let connection = GatewayConnection(
                endpointProvider: { endpoint },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    issuedDeviceToken: hasGrant ? "issued-native-grant" : nil,
                    scopes: ["operator.read"],
                    method: method)))
            try await withControlUIConnection(connection) {
                _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
                if hasGrant {
                    let signed = try await connection.controlUiNativeAuth(
                        endpoint: endpoint,
                        nonce: "nonce",
                        signedAt: 123)
                    let value = try #require(JSONSerialization.jsonObject(with: signed.json) as? [String: Any])
                    #expect(value["auth"] as? [String: String] == ["deviceToken": "issued-native-grant"])
                    #expect(value["scopes"] as? [String] == ["operator.read"])
                } else {
                    await #expect(throws: CancellationError.self) {
                        try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "nonce", signedAt: 123)
                    }
                }
            }
        }
    }

    @Test func `identity-free connections cannot lend native device authority`() async throws {
        let endpoint = try GatewayConnection.EndpointSnapshot(
            config: controlUIRoute("ws://identity-free.invalid", token: "shared"), routeAuthority: 1)
        let connection = GatewayConnection(
            testEndpointProvider: { endpoint },
            sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                issuedDeviceToken: "unexpected-token", scopes: ["operator.admin"])))
        try await withControlUIConnection(connection) {
            _ = try await connection.request(method: "health", params: nil, retryTransportFailures: false)
            await #expect(throws: CancellationError.self) {
                try await connection.controlUiNativeAuth(endpoint: endpoint, nonce: "web-nonce", signedAt: 123)
            }
        }
    }

    @Test func `shared token requires the current live route and socket`() async throws {
        let routeA = try controlUIRoute("ws://route-a.invalid", token: " shared-token ")
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: routeA,
            routeAuthority: 1,
            deviceAuthGatewayID: "route-a"))
        let connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))

        try await withControlUIConnection(connection) {
            #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
            _ = try await connection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(await connection.controlUiAutoAuthToken(config: routeA) == "shared-token")

            let routeB = try controlUIRoute("ws://route-b.invalid", token: routeA.token)
            source.setEndpoint(.init(
                config: routeB,
                routeAuthority: 2,
                deviceAuthGatewayID: "route-b"))

            // The old socket is still physically alive, but neither the old nor
            // the newly selected route may borrow its credential.
            #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
            #expect(await connection.controlUiAutoAuthToken(config: routeB) == nil)
        }
    }

    @Test func `device auto auth reads only the live route scoped token`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "legacy-unscoped-token")
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "route-a-device-token",
                gatewayID: "route-a")

            let routeA = try controlUIRoute("ws://route-a.invalid")
            let routeAConnection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: routeA,
                        routeAuthority: 1,
                        deviceAuthGatewayID: "route-a")
                },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            try await withControlUIConnection(routeAConnection) {
                _ = try await routeAConnection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                #expect(
                    await routeAConnection.controlUiAutoAuthToken(config: routeA) ==
                        "route-a-device-token")
            }

            let routeB = try controlUIRoute("ws://route-b.invalid")
            let routeBConnection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: routeB,
                        routeAuthority: 2,
                        deviceAuthGatewayID: "route-b")
                },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            try await withControlUIConnection(routeBConnection) {
                _ = try await routeBConnection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                #expect(await routeBConnection.controlUiAutoAuthToken(config: routeB) == nil)
            }
        }
    }

    @Test func `hello token cannot cross to a newly selected route`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "route-a-device-token",
                gatewayID: "route-a")
            let routeA = try controlUIRoute("ws://route-a.invalid")
            let source = GatewayConnectionEndpointSource(endpoint: .init(
                config: routeA,
                routeAuthority: 1,
                deviceAuthGatewayID: "route-a"))
            let connection = GatewayConnection(
                endpointProvider: { source.snapshot() },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    issuedDeviceToken: "route-a-issued-token")))

            try await withControlUIConnection(connection) {
                _ = try await connection.request(
                    method: "health",
                    params: nil,
                    retryTransportFailures: false)
                #expect(
                    await connection.controlUiAutoAuthToken(config: routeA) ==
                        "route-a-issued-token")

                source.setEndpoint(.init(
                    config: routeA,
                    routeAuthority: 1,
                    deviceAuthGatewayID: "route-b"))
                #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)

                let routeB = try controlUIRoute("ws://route-b.invalid")
                source.setEndpoint(.init(
                    config: routeB,
                    routeAuthority: 2,
                    deviceAuthGatewayID: "route-b"))
                #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
                #expect(await connection.controlUiAutoAuthToken(config: routeB) == nil)
            }
        }
    }
}
