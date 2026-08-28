import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private final class ControlUIAuthAttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        let current = self.value
        self.value += 1
        return current
    }
}

private actor ControlUIAuthenticationIterator {
    private var iterator: AsyncStream<GatewayConnection.ControlUIAuthenticationState>.Iterator

    init(_ stream: AsyncStream<GatewayConnection.ControlUIAuthenticationState>) {
        self.iterator = stream.makeAsyncIterator()
    }

    func next() async -> GatewayConnection.ControlUIAuthenticationState? {
        var iterator = self.iterator
        let state = await iterator.next()
        self.iterator = iterator
        return state
    }
}

private func makeControlUIAuthSession(
    issuedDeviceToken: String? = nil,
    issuedDeviceTokens: [String] = []) -> GatewayTestWebSocketSession
{
    let attempts = ControlUIAuthAttemptCounter()
    GatewayTestWebSocketSession(taskFactory: {
        let attempt = attempts.next()
        GatewayTestWebSocketTask(
            sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    deviceToken: issuedDeviceTokens.indices.contains(attempt)
                        ? issuedDeviceTokens[attempt]
                        : issuedDeviceToken))
            })
    })
}

private func controlUIRoute(_ rawURL: String, token: String? = nil) throws -> GatewayConnection.Config {
    try (
        url: #require(URL(string: rawURL)),
        token: token,
        password: nil)
}

@Suite(.serialized)
struct GatewayConnectionControlUIAuthTests {
    @Test func `shared token requires the current live route and socket`() async throws {
        let routeA = try controlUIRoute("ws://route-a.invalid", token: " shared-token ")
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: routeA,
            routeAuthority: 1,
            deviceAuthGatewayID: "route-a"))
        let connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))

        #expect(await connection.resolveControlUIAccess(config: routeA)?.access == .token("shared-token"))

        let routeB = try controlUIRoute("ws://route-b.invalid", token: routeA.token)
        source.setEndpoint(.init(
            config: routeB,
            routeAuthority: 2,
            deviceAuthGatewayID: "route-b"))

        // The old socket is still physically alive, but neither the old nor
        // the newly selected route may borrow its credential. The resolver may
        // establish fresh authority for the newly selected route.
        #expect(await connection.resolveControlUIAccess(config: routeA) == nil)
        #expect(await connection.resolveControlUIAccess(config: routeB)?.access == .token("shared-token"))
        await connection.shutdown()
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
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            _ = try await routeAConnection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(
                await routeAConnection.resolveControlUIAccess(config: routeA)?.access ==
                    .token("route-a-device-token"))
            await routeAConnection.shutdown()

            let routeB = try controlUIRoute("ws://route-b.invalid")
            let routeBConnection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: routeB,
                        routeAuthority: 2,
                        deviceAuthGatewayID: "route-b")
                },
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            _ = try await routeBConnection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(await routeBConnection.resolveControlUIAccess(config: routeB)?.access == .noneRequired)
            await routeBConnection.shutdown()
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
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    issuedDeviceToken: "route-a-issued-token")))

            _ = try await connection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(
                await connection.resolveControlUIAccess(config: routeA)?.access ==
                    .token("route-a-issued-token"))

            source.setEndpoint(.init(
                config: routeA,
                routeAuthority: 1,
                deviceAuthGatewayID: "route-b"))
            #expect(await connection.resolveControlUIAccess(config: routeA)?.access == .noneRequired)

            let routeB = try controlUIRoute("ws://route-b.invalid")
            source.setEndpoint(.init(
                config: routeB,
                routeAuthority: 2,
                deviceAuthGatewayID: "route-b"))
            #expect(await connection.resolveControlUIAccess(config: routeA) == nil)
            #expect(await connection.resolveControlUIAccess(config: routeB)?.access == .noneRequired)
            await connection.shutdown()
        }
    }

    @Test func `control UI authentication follows every physical socket generation`() async throws {
        let route = try controlUIRoute("ws://route-a.invalid")
        let session = makeControlUIAuthSession(issuedDeviceTokens: ["device-a", "device-b"])
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "device-seed",
                gatewayID: "route-a")
            let connection = GatewayConnection(
                endpointProvider: {
                    .init(config: route, routeAuthority: 1, deviceAuthGatewayID: "route-a")
                },
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: session))
            let stream = await connection.subscribeControlUIAuthentication()
            let iterator = ControlUIAuthenticationIterator(stream)

            #expect(await iterator.next() == .pending)
            _ = try await connection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(await iterator.next() == .authenticated(routeGeneration: 1, socketGeneration: 1))
            #expect(await connection.resolveControlUIAccess(config: route)?.access == .token("device-a"))

            let firstSocket = try #require(session.latestTask())
            try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { CancellationError() },
                operation: {
                    while !firstSocket.hasPendingReceiveHandler() {
                        await Task.yield()
                    }
                })
            firstSocket.emitReceiveFailure()

            let reconnectStates = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { CancellationError() },
                operation: {
                    [await iterator.next(), await iterator.next()]
                })
            #expect(reconnectStates == [
                .pending,
                .authenticated(routeGeneration: 1, socketGeneration: 2),
            ])
            #expect(await connection.resolveControlUIAccess(config: route)?.access == .token("device-b"))
            await connection.shutdown()
        }
    }
}
