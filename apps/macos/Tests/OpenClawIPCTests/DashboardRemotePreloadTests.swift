import AppKit
import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// Hands each primary lookup its own gate, so a test can resume them in order.
private actor DashboardRemotePreloadLookups {
    private let gates: [DashboardWindowOwnershipPresentationGate]
    private var started = 0

    init(_ gates: [DashboardWindowOwnershipPresentationGate]) {
        self.gates = gates
    }

    func waitForRelease() async {
        let gate = self.gates[min(self.started, self.gates.count - 1)]
        self.started += 1
        await gate.waitForRelease()
    }
}

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardRemotePreloadTests {
    private func remoteManager(
        server: DashboardHTTPFixture,
        lookupGates: [DashboardWindowOwnershipPresentationGate]) -> DashboardManager
    {
        let lookups = DashboardRemotePreloadLookups(lookupGates)
        return DashboardManager._testMake(primaryEndpointProvider: { _ in
            await lookups.waitForRelease()
            return GatewayConnection.EndpointSnapshot(
                config: (url: server.websocketURL(), token: "primary", password: nil), routeAuthority: nil)
        })
    }

    /// Runs `body` as a remote-mode launch after onboarding, the state the menu bar preload sees.
    private func withRemoteLaunch(_ body: () async throws -> Void) async throws {
        // Window lookups read NSApp; create it here instead of relying on test order.
        _ = NSApplication.shared
        let state = AppStateStore.shared
        let originalMode = state.connectionMode
        let originalOnboarding = state.onboardingSeen
        state.connectionMode = .remote
        state.onboardingSeen = true
        defer {
            state.connectionMode = originalMode
            state.onboardingSeen = originalOnboarding
        }
        try await body()
    }

    @Test func `first open reuses the hidden remote preload document`() async throws {
        try await TestIsolation.withIsolatedState { try await self.withRemoteLaunch {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let lookupGate = DashboardWindowOwnershipPresentationGate(released: true)
            let manager = self.remoteManager(server: server, lookupGates: [lookupGate])
            defer { manager.close() }
            manager.testControlChannelConnected = true

            await manager.preloadIfConfigured()?.value
            let preloaded = try #require(manager._testController())
            #expect(!preloaded.isWindowOpen)
            // Native sign-in challenges are answered only for retained windows.
            #expect(preloaded.hasRetainedWindow)
            #expect(preloaded.documentHost.isNativeAuthAvailable())
            // The menu counts only windows the user has seen.
            #expect(manager.openWindowCount(for: .primary) == 0)

            try await manager.show()

            #expect(manager._testController() === preloaded)
            #expect(preloaded.isWindowOpen)
            #expect(!preloaded.isHiddenForExperience)
            #expect(manager.openWindowCount(for: .primary) == 1)
            #expect(preloaded.auth.token == "primary")
        } }
    }

    @Test func `open in flight before authentication owns the first document`() async throws {
        try await TestIsolation.withIsolatedState { try await self.withRemoteLaunch {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let lookupGate = DashboardWindowOwnershipPresentationGate()
            let manager = self.remoteManager(server: server, lookupGates: [lookupGate])
            defer { manager.close() }
            manager.testControlChannelConnected = false
            #expect(manager.preloadIfConfigured() == nil)

            let opening = manager.openOrFocusDashboard(for: .primary)
            await lookupGate.waitUntilRequested()
            manager.testControlChannelConnected = true
            await manager._testHandleControlChannelStateChange(.connected)
            await lookupGate.release()
            await opening.value

            // A preload that started here would install a hidden controller first
            // and make the open's ownership guard drop its window.
            let opened = try #require(manager._testController())
            #expect(opened.isWindowOpen)
        } }
    }

    @Test func `open that starts during the preload lookup owns the first document`() async throws {
        try await TestIsolation.withIsolatedState { try await self.withRemoteLaunch {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let preloadLookup = DashboardWindowOwnershipPresentationGate()
            let openLookup = DashboardWindowOwnershipPresentationGate()
            let manager = self.remoteManager(server: server, lookupGates: [preloadLookup, openLookup])
            defer { manager.close() }
            manager.testControlChannelConnected = true

            let preload = try #require(manager.preloadIfConfigured())
            await preloadLookup.waitUntilRequested()
            let opening = manager.openOrFocusDashboard(for: .primary)
            await openLookup.waitUntilRequested()
            // The preload finishes its lookup first, while the open still waits on its own.
            await preloadLookup.release()
            await preload.value
            #expect(manager._testController() == nil)
            await openLookup.release()
            await opening.value

            let opened = try #require(manager._testController())
            #expect(opened.isWindowOpen)
        } }
    }

    @Test func `hidden remote preload follows an endpoint change before the first open`() async throws {
        try await TestIsolation.withIsolatedState { try await self.withRemoteLaunch {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let replacementServer = try await DashboardHTTPFixture.start()
            defer { replacementServer.stop() }
            let lookupGate = DashboardWindowOwnershipPresentationGate(released: true)
            let manager = self.remoteManager(server: server, lookupGates: [lookupGate])
            defer { manager.close() }
            manager.testControlChannelConnected = true
            await manager.preloadIfConfigured()?.value
            let preloadedWindow = try #require(manager._testController()?.window)

            await manager.handleEndpointState(.ready(
                mode: .remote,
                url: replacementServer.websocketURL(),
                token: "rotated-primary-token",
                password: nil,
                routeRevision: 2))

            let reconciled = try #require(manager._testController())
            #expect(reconciled.auth.token == "rotated-primary-token")
            #expect(reconciled.window === preloadedWindow)
            #expect(!reconciled.isWindowOpen)
            #expect(reconciled.hasRetainedWindow)
            #expect(manager.openWindowCount(for: .primary) == 0)
        } }
    }

    /// The hidden preload is a retained document, so the native challenge bridge
    /// answers it while it is current, and refuses once its socket, document or
    /// identity is no longer the one that asked (same contract as an open window).
    @Test(arguments: ["current", "socket", "document", "browser-identity-pending", "browser-identity"])
    func `hidden remote preload answers native challenges only while its document is current`(
        _ transition: String) async throws
    {
        try await TestIsolation.withIsolatedState { try await self.withRemoteLaunch {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let manager = self.remoteManager(
                server: server, lookupGates: [DashboardWindowOwnershipPresentationGate(released: true)])
            defer { manager.close() }
            manager.testControlChannelConnected = true

            await manager.preloadIfConfigured()?.value
            let preloaded = try #require(manager._testController())
            #expect(!preloaded.isWindowOpen)
            let calls = LockIsolated(0)
            let requested = AsyncTestGate()
            let release = AsyncTestGate()
            defer { release.open() }
            let current = LockIsolated(true)
            preloaded.documentHost.nativeGatewayAuthProvider = { _, _ in
                calls.withValue { $0 += 1 }
                requested.open()
                await release.wait()
                return DashboardNativeGatewayAuth(
                    json: Data(#"{"auth":{"deviceToken":"native-grant"},"scopes":["operator.read"]}"#.utf8),
                    isCurrent: { current.value })
            }
            try await waitForNativeDashboardDocument(preloaded)
            if transition == "browser-identity" {
                // A browser identity document never reaches the native provider.
                preloaded.auth = .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
            }
            let pending = Task {
                try await preloaded.webView.callAsyncJavaScript("""
                try {
                  return JSON.stringify(await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                    id: 'request', nonce: 'challenge', signedAt: 123
                  }));
                } catch (error) { return JSON.stringify({rejected: String(error)}); }
                """, in: nil, contentWorld: .page) as? String
            }
            if transition != "browser-identity" {
                do {
                    try await AsyncTimeout.withTimeout(
                        seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await requested.wait() })
                } catch {
                    release.open()
                    _ = await pending.result
                    throw error
                }
                switch transition {
                case "socket": current.setValue(false)
                case "document": preloaded.webView(preloaded.webView, didCommit: nil)
                case "browser-identity-pending":
                    preloaded.auth = .browserIdentity(gatewayUrl: server.websocketURL().absoluteString)
                default: break
                }
                release.open()
            }
            let json = try #require(try await pending.value)
            let received = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
            switch transition {
            case "current":
                let result = try #require(received["result"] as? [String: Any])
                #expect((result["auth"] as? [String: String])?["deviceToken"] == "native-grant")
            case "browser-identity":
                #expect(received["rejected"] != nil)
                #expect(calls.value == 0)
            default:
                #expect(received["error"] as? String != nil)
                #expect(received["result"] == nil)
            }
            // Answering or refusing a challenge never shows the preload.
            #expect(!preloaded.isWindowOpen)
        } }
    }
}
