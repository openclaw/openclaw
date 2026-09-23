import AppKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct WebChatWindowLifetimeTests {
    @Test func `a pending primary open cannot outlive its owner`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 1))
                .write(to: URL(fileURLWithPath: configPath))
            // Only injected primary connections participate; no child owns a shared fleet connection.
            async let ordinaryManager: Void = self.checkPendingPrimaryOpen(admission: "ordinary", closeOwner: "manager")
            async let ordinaryWindow: Void = self.checkPendingPrimaryOpen(
                admission: "ordinary",
                closeOwner: "native window")
            async let ordinaryHide: Void = self.checkPendingPrimaryOpen(admission: "ordinary", closeOwner: "hide")
            async let transcriptManager: Void = self.checkPendingPrimaryOpen(
                admission: "transcript",
                closeOwner: "manager")
            async let transcriptWindow: Void = self.checkPendingPrimaryOpen(
                admission: "transcript", closeOwner: "native window")
            async let transcriptHide: Void = self.checkPendingPrimaryOpen(admission: "transcript", closeOwner: "hide")
            _ = try await (
                ordinaryManager, ordinaryWindow, ordinaryHide,
                transcriptManager, transcriptWindow, transcriptHide)
        }
    }

    private func checkPendingPrimaryOpen(admission: String, closeOwner: String) async throws {
        let fixture = CronSourceFixture()
        do {
            try await withWebChatManagerLifetime(primaryConnection: fixture.gateway) { manager in
                let lease = try await fixture.gateway.acquireServerLease()
                let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
                manager.show(sessionKey: "existing-primary-\(UUID().uuidString)")
                let window = try #require(NSApp.windows.first { !previousWindows.contains(ObjectIdentifier($0)) })
                // Primary opens enqueue MainActor work. Close before yielding so the
                // pending admission cannot run until its owner is gone.
                var rejected = false
                if admission == "ordinary" {
                    // Supplying an agent keeps the existing window from satisfying this default-session lookup.
                    manager.show(agentID: "main")
                } else {
                    manager.show(sessionKey: "cron:shared-job", ifCurrentRouteFrom: lease) { rejected = true }
                }
                if closeOwner == "manager" {
                    manager.close()
                } else if closeOwner == "hide" {
                    manager.hideWindows()
                } else {
                    window.close()
                }
                #expect(manager.activeSessionKey == nil, "\(admission) admission retired by \(closeOwner)")
                #expect(
                    await !self.eventually { manager.activeSessionKey != nil },
                    "\(admission) admission retired by \(closeOwner)")
                #expect(!rejected, "\(admission) admission retired by \(closeOwner)")
            }
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `concurrent cold primary opens honor the new window choice`(newWindow: Bool) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        let fixture = CronSourceFixture()
        do {
            try await withIsolatedWebChatManager(
                primaryConnection: fixture.gateway,
                env: ["OPENCLAW_CONFIG_PATH": configPath])
            { manager in
                try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 1))
                    .write(to: URL(fileURLWithPath: configPath))
                let first = manager.openGatewayWindow(for: .primary, newWindow: newWindow)
                let second = manager.openGatewayWindow(for: .primary, newWindow: newWindow)
                await first.value
                await second.value
                #expect(manager.openWindowCount(for: .primary) == (newWindow ? 2 : 1))
                #expect(manager.frontmostGatewayTarget == .primary)
                #expect(manager.hasVisibleWindows)
            }
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["show", "new window"])
    func `a retired socket cannot finish a primary main session open`(entrypoint: String) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        let fixture = CronSourceFixture(holding: "config.get")
        do {
            try await withIsolatedWebChatManager(
                primaryConnection: fixture.gateway,
                env: ["OPENCLAW_CONFIG_PATH": configPath])
            { manager in
                try JSONSerialization.data(withJSONObject: CronSourceFixture.configuration(revision: 1))
                    .write(to: URL(fileURLWithPath: configPath))
                let lease = try await fixture.gateway.acquireServerLease()
                let pending: Task<Void, Never>?
                if entrypoint == "show" {
                    manager.show()
                    pending = nil
                } else {
                    pending = manager.openGatewayWindow(for: .primary, newWindow: true)
                }
                try #require(await self.eventually { fixture.requests.value.contains { $0.method == "config.get" } })
                let request = try #require(fixture.requests.value.first { $0.method == "config.get" })
                // Retire only the socket: the manager generation, configured route,
                // and device-auth Gateway ID still match the delayed admission.
                await fixture.gateway._test_handleDisconnect(socketGeneration: lease.socketGeneration)
                #expect(fixture.gateway.serverLeaseMatchesCurrentRoute(lease))
                #expect(!fixture.gateway.serverLeaseMatchesCurrentState(lease))
                try request.socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: [
                    "type": "res", "id": request.id, "ok": true,
                    "payload": ["config": ["session": ["scope": "global"]]],
                ])))
                if let pending {
                    await pending.value
                    #expect(!manager.hasVisibleWindows)
                } else {
                    #expect(await !self.eventually { manager.hasVisibleWindows })
                }
                #expect(manager.openWindowCount(for: .primary) == 0)
                #expect(manager.activeSessionKey == nil)
            }
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `selecting a profile session preserves the primary active session`() async throws {
        try await withIsolatedWebChatManager { manager in
            manager.show(sessionKey: "primary-session")
            let connection = GatewayConnection(
                endpointProvider: { throw CancellationError() },
                supportsSharedEndpointRecovery: false)
            let transport = MacGatewayChatTransport(connection: connection)

            try? await transport.setActiveSessionKey("profile-session")

            #expect(manager.activeSessionKey == "primary-session")
            await connection.shutdown()
        }
    }

    @Test func `replacing the primary Gateway retires its windows and preserves profiles`() async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            await manager.openGatewayWindow(for: .profile(profile.id), newWindow: true).value
            manager.show(sessionKey: "primary-proof")
            manager.show(sessionKey: "second-primary")
            let originalGatewayID = GatewayDiscoveryPreferences.deviceAuthGatewayID(root: OpenClawConfigFile.loadDict())

            manager.preparePrimaryGateway(gatewayID: originalGatewayID)
            #expect(manager.openWindowCount(for: .primary) == 2)
            #expect(manager.activeSessionKey == "second-primary")

            manager.preparePrimaryGateway(gatewayID: "replacement-primary")
            #expect(manager.openWindowCount(for: .primary) == 0)
            #expect(manager.activeSessionKey == nil)
            #expect(manager.hasVisibleWindows)
            #expect(manager.openWindowCount(for: .profile(profile.id)) == 1)
            manager.closeGatewayWindows(profileID: profile.id)
        }
    }

    @Test func `hiding clears voice ownership and reopening restores the retained primary route`() async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            manager.show(sessionKey: "first-primary")
            manager.show(sessionKey: "second-primary")
            #expect(manager.activeSessionKey == "second-primary")
            manager.show(sessionKey: "first-primary")
            #expect(manager.activeSessionKey == "first-primary")
            #expect(manager.openWindowCount(for: .primary) == 2)
            await manager.openGatewayWindow(for: .profile(profile.id)).value
            #expect(manager.frontmostGatewayTarget == .profile(profile.id))
            #expect(manager.activeSessionKey == "first-primary")

            manager.hideWindows()
            #expect(!manager.hasVisibleWindows)
            #expect(manager.activeSessionKey == nil)
            manager.recordActiveSessionKey("hidden-update")
            #expect(manager.activeSessionKey == nil)
            await manager.openGatewayWindow(for: .primary).value
            #expect(manager.activeSessionKey == "first-primary")
            #expect(manager.frontmostGatewayTarget == .primary)
            #expect(manager.openWindowCount(for: .primary) == 2)
        }
    }

    @Test(arguments: [false, true])
    func `retiring a profile connection releases its session observer`(closeAll: Bool) async throws {
        try await withIsolatedWebChatProfile { manager, profile in
            var connection: GatewayConnection? = await MacGatewayConnectionFleet.shared
                .connection(profileID: profile.id)
            weak var retiredConnection = connection
            await manager.openGatewayWindow(for: .profile(profile.id), newWindow: true).value
            if closeAll {
                manager.close()
            } else {
                try await MacGatewayProfileStore.shared.remove(profileID: profile.id)
            }
            connection = nil

            #expect(await self.eventually { retiredConnection == nil })
        }
    }

    @Test func `closing a chat window retires observation and rejects late history cache writes`() async throws {
        let transport = ClosingWindowChatTransport()
        let cache = ClosingWindowTranscriptCache()
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            transport: transport,
            transcriptCache: cache)
        defer {
            transport.releaseHistory.open()
            transport.finishEvents()
            controller.close()
        }

        controller.show()
        try #require(await self.eventually { transport.historyStarted })
        controller.close()
        transport.releaseHistory.open()
        try #require(await self.eventually { transport.historyReturned })

        #expect(await self.eventually { transport.observationTerminated })
        #expect(await cache.savedTranscripts.isEmpty)
    }

    private func eventually(_ predicate: @escaping () async -> Bool) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(3)
        while clock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return await predicate()
    }
}

@MainActor
func withIsolatedWebChatProfile(
    _ body: @MainActor (WebChatManager, MacGatewayProfile) async throws -> Void) async throws
{
    try await withIsolatedWebChatManager { manager in
        // Window admission uses the saved profile's account owner. Keep network
        // attempts on a test-owned loopback endpoint while exercising that lookup.
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let store = MacGatewayProfileStore.shared
        let attempt = try await store.beginBrowserSignIn(url: server.websocketURL("/\(UUID().uuidString)"))
        let profile = try await store.saveConnection(
            name: "Window fixture",
            token: nil,
            password: nil,
            attempt: attempt)
        var failure: (any Error)?
        do {
            try await body(manager, profile)
        } catch {
            failure = error
        }
        if try await store.profiles().contains(where: { $0.id == profile.id }) {
            try await store.remove(profileID: profile.id)
        }
        if let failure { throw failure }
    }
}

@MainActor
func withIsolatedWebChatManager(
    primaryConnection: GatewayConnection = .shared,
    env: [String: String?] = [:],
    _ body: (WebChatManager) async throws -> Void) async throws
{
    try await TestIsolation.withIsolatedState(env: env) {
        try await withWebChatManagerLifetime(primaryConnection: primaryConnection, body)
    }
}

@MainActor
func withWebChatManagerLifetime(
    primaryConnection: GatewayConnection = .shared,
    _ body: (WebChatManager) async throws -> Void) async throws
{
    // Callers inspect NSApp before opening their first window.
    _ = AppKitTestSupport.application
    weak var retiredManager: WebChatManager?
    let suiteName = "WebChatSelectionTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    var failure: (any Error)?
    do {
        let manager = WebChatManager(
            primaryConnection: primaryConnection,
            selection: MacGatewaySelectionPreferences(defaults: defaults))
        retiredManager = manager
        defer { manager.close() }
        try await body(manager)
    } catch {
        failure = error
    }
    // close() owns asynchronous fleet retirement. Keep the global lease
    // until that task releases its manager so it cannot shut down the next fixture.
    let deadline = ContinuousClock.now + .seconds(3)
    while retiredManager != nil, ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(10))
    }
    #expect(retiredManager == nil)
    if let failure { throw failure }
}

private final class ClosingWindowChatTransport: @unchecked Sendable, OpenClawChatTransport {
    let releaseHistory = AsyncTestGate()
    private let lock = NSLock()
    private var didStartHistory = false
    private var didReturnHistory = false
    private var didTerminateObservation = false
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init() {
        (self.stream, self.continuation) = AsyncStream.makeStream()
        self.continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.lock.withLock { self.didTerminateObservation = true }
        }
    }

    var historyStarted: Bool {
        self.lock.withLock { self.didStartHistory }
    }

    var historyReturned: Bool {
        self.lock.withLock { self.didReturnHistory }
    }

    var observationTerminated: Bool {
        self.lock.withLock { self.didTerminateObservation }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.lock.withLock { self.didStartHistory = true }
        await self.releaseHistory.wait()
        self.lock.withLock { self.didReturnHistory = true }
        // A response may already have been decoded when its caller is canceled.
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data("""
        {"sessionKey":"\(sessionKey)","sessionId":"late-history","thinkingLevel":"off",\
        "messages":[{"role":"assistant","content":[{"type":"text","text":"late Gateway history"}]}]}
        """.utf8))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        OpenClawChatSendResponse(runId: idempotencyKey, status: "accepted")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func finishEvents() {
        self.continuation.finish()
    }
}

private actor ClosingWindowTranscriptCache: OpenClawChatTranscriptCache {
    private(set) var savedTranscripts: [[OpenClawChatMessage]] = []

    func loadSessions() async -> [OpenClawChatSessionEntry] {
        []
    }

    func loadTranscript(sessionKey _: String) async -> [OpenClawChatMessage] {
        []
    }

    func storeSessions(_: [OpenClawChatSessionEntry]) async {}

    func storeCanonicalTranscript(
        sessionKey _: String,
        agentID _: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async
    {
        self.savedTranscripts.append(messages)
    }
}
