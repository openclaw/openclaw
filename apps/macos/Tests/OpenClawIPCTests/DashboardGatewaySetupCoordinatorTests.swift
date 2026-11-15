import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct DashboardGatewaySetupCoordinatorTests {
    @Test func `cancel prompts once and preserves primary state without credential disclosure`() async throws {
        var persistCount = 0
        let state = AppState(preview: true, gatewayConfigSaver: { _, _ in
            persistCount += 1
            return true
        })
        state.remoteTransport = .ssh
        state.remoteUrl = "wss://previous.example:443"
        state.remoteToken = "previous-token"
        state.connectionMode = .local
        let token = "fixture-token"
        let link = GatewayConnectDeepLink(
            host: "192.168.1.20",
            port: 18789,
            tls: false,
            bootstrapToken: nil,
            token: token,
            password: nil)
        var prompts: [(String, String)] = []
        var openedSettings = 0
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: DashboardPrimaryGatewayAdapter(state: state),
            confirm: { title, message in
                prompts.append((title, message))
                return false
            },
            presentError: { _, _ in Issue.record("unexpected error") },
            openConnectionSettings: { openedSettings += 1 })

        await coordinator.handle(link)

        #expect(prompts.count == 1)
        let prompt = try #require(prompts.first)
        #expect(!prompt.0.contains(token))
        #expect(!prompt.1.contains(token))
        #expect(prompt.1.contains("unencrypted private-network connection"))
        #expect(!prompt.1.localizedCaseInsensitiveContains("loopback"))
        #expect(state.remoteTransport == .ssh)
        #expect(state.remoteUrl == "wss://previous.example:443")
        #expect(state.remoteToken == "previous-token")
        #expect(state.connectionMode == .local)
        #expect(persistCount == 0)
        #expect(openedSettings == 0)
    }

    @Test func `accept persists primary and opens connection settings`() async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            var openedSettings = 0
            let coordinator = DashboardGatewaySetupCoordinator(
                adapter: DashboardPrimaryGatewayAdapter(state: state),
                confirm: { _, _ in true },
                presentError: { _, _ in Issue.record("unexpected error") },
                openConnectionSettings: { openedSettings += 1 })
            let link = GatewayConnectDeepLink(
                host: "gateway.example",
                port: 443,
                tls: true,
                bootstrapToken: nil,
                token: "fixture-token",
                password: nil)

            await coordinator.handle(link)

            let root = OpenClawConfigFile.loadDict()
            #expect(GatewayRemoteConfig.resolveGatewayUrl(root: root) == link.websocketURL)
            #expect(GatewayRemoteConfig.resolveTokenString(root: root) == "fixture-token")
            #expect(openedSettings == 1)
        }
    }

    @Test(arguments: [false, true])
    func `invalid or expired setup rejects before prompting or mutation`(expired: Bool) async throws {
        let state = AppState(preview: true)
        state.remoteUrl = "wss://previous.example:443"
        var promptCount = 0
        var errors: [(String, String)] = []
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: DashboardPrimaryGatewayAdapter(state: state),
            confirm: { _, _ in
                promptCount += 1
                return true
            },
            presentError: { errors.append(($0, $1)) },
            openConnectionSettings: { Issue.record("unexpected settings open") })
        let token = "fixture-token"
        let link = GatewayConnectDeepLink(
            host: "gateway.example",
            port: 443,
            tls: true,
            tlsFingerprintSha256: expired ? nil : "invalid-pin",
            expiresAtMs: expired ? 1 : nil,
            bootstrapToken: nil,
            token: token,
            password: nil)

        await coordinator.handle(link)

        #expect(promptCount == 0)
        #expect(errors.count == 1)
        let error = try #require(errors.first)
        #expect(!error.0.contains(token))
        #expect(!error.1.contains(token))
        #expect(state.remoteUrl == "wss://previous.example:443")
    }

    @Test(arguments: [false, true])
    func `setup confirmation cannot replace a newer primary selection`(fileEdit: Bool) async {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            #expect(OpenClawConfigFile.saveDict([
                "gateway": ["mode": "remote", "remote": [
                    "transport": "direct", "url": "wss://previous.example:443", "token": "previous-token",
                ]],
            ]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            var errors: [String] = []
            var openedSettings = 0
            let coordinator = DashboardGatewaySetupCoordinator(
                adapter: DashboardPrimaryGatewayAdapter(state: state),
                confirm: { _, _ in
                    if fileEdit {
                        var root = OpenClawConfigFile.loadDict()
                        var gateway = root["gateway"] as? [String: Any] ?? [:]
                        var remote = gateway["remote"] as? [String: Any] ?? [:]
                        remote["url"] = "wss://newer.example:443"
                        remote["token"] = "newer-token"
                        gateway["remote"] = remote
                        root["gateway"] = gateway
                        #expect(OpenClawConfigFile.saveDict(root))
                        #expect(GatewayRemoteConfig.resolveUrlString(root: OpenClawConfigFile.loadDict()) ==
                            "wss://newer.example:443")
                    } else {
                        state.remoteUrl = "wss://newer.example:443"
                    }
                    return true
                },
                presentError: { _, message in errors.append(message) },
                openConnectionSettings: { openedSettings += 1 })
            let link = GatewayConnectDeepLink(
                host: "gateway.example",
                port: 443,
                tls: true,
                bootstrapToken: nil,
                token: "fixture-token",
                password: nil)

            await coordinator.handle(link)
            await state._testAwaitGatewayConfigSync()

            #expect(errors.count == 1)
            #expect(!errors.contains { $0.contains("fixture-token") })
            #expect(openedSettings == 0)
            let root = OpenClawConfigFile.loadDict()
            #expect(GatewayRemoteConfig.resolveUrlString(root: root) == "wss://newer.example:443")
        }
    }
}
