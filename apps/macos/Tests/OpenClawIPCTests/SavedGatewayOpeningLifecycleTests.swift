import AppKit
import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct SavedGatewayOpeningFixture: Sendable {
    let source: GatewayConnectionEndpointSource
    let connection: GatewayConnection
    let session: GatewayTestWebSocketSession
    let pendingHealth: LockIsolated<(GatewayTestWebSocketTask, String)?>
    let healthChanged: AsyncTestSignal

    init(url: URL) {
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: (url, "synthetic-opening-token", nil), routeAuthority: nil))
        let pendingHealth = LockIsolated<(GatewayTestWebSocketTask, String)?>(nil)
        let holdFirstHealth = LockIsolated(true)
        let healthChanged = AsyncTestSignal()
        let session = GatewayTestWebSocketSession {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                if holdFirstHealth.withValue({ held in
                    let previous = held
                    held = false
                    return previous
                }) {
                    // Withhold external I/O, not an invented shutdown error. Sending
                    // returns normally so the real channel owns the pending waiter.
                    pendingHealth.setValue((socket, id))
                    healthChanged.notify()
                } else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        }
        self.source = source
        self.connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() }, sessionBox: WebSocketSessionBox(session: session))
        self.session = session
        self.pendingHealth = pendingHealth
        self.healthChanged = healthChanged
    }

    func waitForHealth() async throws {
        try await self.healthChanged.wait("first opening health request") { self.pendingHealth.value != nil }
    }

    func releaseHealth() {
        let pending = self.pendingHealth.withValue { pending in
            defer { pending = nil }
            return pending
        }
        if let (socket, id) = pending {
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        }
    }

    func fleet() -> MacGatewayConnectionFleet {
        MacGatewayConnectionFleet(
            profileChatStoreID: { _ in "synthetic-opening-owner" },
            makeConnection: { _ in self.connection })
    }
}

@Suite(.serialized, .testWaitLimit)
@MainActor
struct SavedGatewayOpeningLifecycleTests {
    @Test func `queued idle cleanup cannot retire a first open or its retained window`() async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let fixture = SavedGatewayOpeningFixture(url: server.websocketURL())
            let fleet = fixture.fleet()
            let target = DashboardGatewayTarget.profile("opening-lifecycle")
            _ = try await fleet.binding(profileID: "opening-lifecycle")
            let manager = DashboardManager._testMake(
                connectionProvider: { _ in fixture.connection },
                connectionFleet: fleet,
                browserIdentityURLProvider: nil,
                profileEndpointProvider: { _ in fixture.source.snapshot() })
            let cleanupGate = GatewayConnectionSuspensionGate()
            let cleanup = Task {
                await cleanupGate.suspend()
                await fleet.disconnect(profileID: "opening-lifecycle", onlyIfIdle: true)
            }
            await cleanupGate.waitUntilStarted()
            // The settings and bridge paths share this real configuration owner,
            // not the menu's private collection of opening tasks.
            let opening = Task {
                let resolved = try await manager.windowConfiguration(for: target)
                #expect(resolved.configuration.auth.token == "synthetic-opening-token")
            }
            let result: Result<Void, Error>
            do {
                try await fixture.waitForHealth()
                await cleanupGate.open()
                await cleanup.value
                fixture.releaseHealth()
                try await opening.value
                await manager._testOpenWindow(for: target)
                let controller = try #require(manager._testAuxiliaryWindows().first?.controller)
                let lease = try #require(await fixture.connection.captureServerLease())
                controller.hideForExperience()
                await fleet.disconnect(profileID: "opening-lifecycle", onlyIfIdle: true)
                #expect(fixture.connection.serverLeaseMatchesCurrentState(lease))
                #expect(fixture.session.snapshotMakeCount() == 1)
                controller.closeDashboard()
                await fleet.disconnect(profileID: "opening-lifecycle", onlyIfIdle: true)
                #expect(!fixture.connection.serverLeaseMatchesCurrentState(lease))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await cleanupGate.open()
            await cleanup.value
            fixture.releaseHealth()
            opening.cancel()
            _ = await opening.result
            manager.close()
            await fixture.connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: ["credentials", "removal", "cancellation"])
    func `revocation and cancellation still interrupt pending opens`(action: String) async throws {
        try await TestIsolation.withIsolatedState {
            let fixture = SavedGatewayOpeningFixture(url: try #require(URL(string: "ws://127.0.0.1:28931")))
            let fleet = fixture.fleet()
            _ = try await fleet.binding(profileID: "opening-lifecycle")
            let manager = DashboardManager._testMake(
                connectionProvider: { _ in fixture.connection },
                connectionFleet: fleet,
                browserIdentityURLProvider: nil,
                profileEndpointProvider: { _ in fixture.source.snapshot() })
            let opening = Task { try await manager.windowConfiguration(for: .profile("opening-lifecycle")) }
            let result: Result<Void, Error>
            do {
                try await fixture.waitForHealth()
                switch action {
                case "removal": _ = await fleet.remove(profileID: "opening-lifecycle")
                case "cancellation": opening.cancel()
                default: await fleet.disconnect(profileID: "opening-lifecycle")
                }
                await #expect(throws: (any Error).self) { try await opening.value }
                fixture.releaseHealth()
                await fleet.disconnect(profileID: "opening-lifecycle", onlyIfIdle: true)
                #expect(!fixture.connection.hasConnectedServer)
                #expect(fixture.session.snapshotMakeCount() == 1)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            fixture.releaseHealth()
            opening.cancel()
            _ = await opening.result
            manager.close()
            await fixture.connection.shutdown()
            try result.get()
        }
    }
}
