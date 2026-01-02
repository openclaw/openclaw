import Foundation
import Testing
@testable import Clawdis

@Suite struct GatewayEndpointStoreTests {
    private final class ModeBox: @unchecked Sendable {
        private let lock = NSLock()
        private var value: AppState.ConnectionMode

        init(_ initial: AppState.ConnectionMode) {
            self.value = initial
        }

        func get() -> AppState.ConnectionMode {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.value
        }

        func set(_ next: AppState.ConnectionMode) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.value = next
        }
    }

    @Test func localRefreshResolvesToLocalhostPort() async throws {
        let mode = ModeBox(.local)
        let store = GatewayEndpointStore(deps: .init(
            mode: { mode.get() },
            token: { "t" },
            password: { nil },
            localPort: { 1234 },
            remotePortIfRunning: { nil },
            ensureRemoteTunnel: { 18789 }))

        await store.refresh()
        let cfg = try await store.requireConfig()
        #expect(cfg.url.absoluteString == "ws://127.0.0.1:1234")
        #expect(cfg.token == "t")
    }

    @Test func remoteWithoutTunnelRecoversByEnsuringTunnel() async throws {
        let mode = ModeBox(.remote)
        let store = GatewayEndpointStore(deps: .init(
            mode: { mode.get() },
            token: { nil },
            password: { nil },
            localPort: { 18789 },
            remotePortIfRunning: { nil },
            ensureRemoteTunnel: { 18789 }))

        let cfg = try await store.requireConfig()
        #expect(cfg.url.absoluteString == "ws://127.0.0.1:18789")
        #expect(cfg.token == nil)
    }

    @Test func ensureRemoteTunnelPublishesReadyState() async throws {
        let mode = ModeBox(.remote)
        let store = GatewayEndpointStore(deps: .init(
            mode: { mode.get() },
            token: { "tok" },
            password: { "pw" },
            localPort: { 1 },
            remotePortIfRunning: { 5555 },
            ensureRemoteTunnel: { 5555 }))

        let stream = await store.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        _ = await iterator.next() // initial
        _ = try await store.ensureRemoteControlTunnel()

        let next = await iterator.next()
        guard case let .ready(mode, url, token, password) = next else {
            Issue.record("expected .ready after ensure, got \(String(describing: next))")
            return
        }
        #expect(mode == .remote)
        #expect(url.absoluteString == "ws://127.0.0.1:5555")
        #expect(token == "tok")
        #expect(password == "pw")
    }

    @Test func resolvesGatewayPasswordByMode() {
        let root: [String: Any] = [
            "gateway": [
                "auth": ["password": " local "],
                "remote": ["password": " remote "],
            ],
        ]
        let env: [String: String] = [:]

        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: env) == "local")
        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: true,
            root: root,
            env: env) == "remote")
    }

    @Test func gatewayPasswordEnvOverridesConfig() {
        let root: [String: Any] = [
            "gateway": [
                "auth": ["password": "local"],
                "remote": ["password": "remote"],
            ],
        ]
        let env = ["CLAWDIS_GATEWAY_PASSWORD": " env "]

        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: env) == "env")
        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: true,
            root: root,
            env: env) == "env")
    }

    @Test func gatewayPasswordIgnoresWhitespaceValues() {
        let root: [String: Any] = [
            "gateway": [
                "auth": ["password": "   "],
                "remote": ["password": "\n\t"],
            ],
        ]
        let env = ["CLAWDIS_GATEWAY_PASSWORD": "  "]

        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: false,
            root: root,
            env: env) == nil)
        #expect(GatewayEndpointStore._testResolveGatewayPassword(
            isRemote: true,
            root: root,
            env: env) == nil)
    }

    @Test func unconfiguredModeRejectsConfig() async {
        let mode = ModeBox(.unconfigured)
        let store = GatewayEndpointStore(deps: .init(
            mode: { mode.get() },
            token: { nil },
            password: { nil },
            localPort: { 18789 },
            remotePortIfRunning: { nil },
            ensureRemoteTunnel: { 18789 }))

        await #expect(throws: Error.self) {
            _ = try await store.requireConfig()
        }
    }
}
