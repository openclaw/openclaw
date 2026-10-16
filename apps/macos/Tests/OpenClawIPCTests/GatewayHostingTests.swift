import Foundation
import Testing
@testable import OpenClaw

struct GatewayHostingTests {
    @MainActor
    @Test func `termination rejects late activation and recovery`() async {
        let manager = GatewayProcessManager()
        await manager.shutdownAppHostedGateway()
        manager.setActive(true)
        manager.setActive(true, source: .recovery)
        manager.startIfNeeded()
        #expect(manager.status == .stopped)
        #expect(!manager.hasAppHostedGateway)
    }

    @MainActor
    @Test func `selecting app hosting retires the service resume command`() async {
        await TestIsolation.withUserDefaultsValues([
            GatewayHosting.defaultsKey: nil,
            GatewayLaunchAgentManager.resumeCommandKey: nil,
        ]) {
            let manager = GatewayProcessManager()
            manager.retainedServiceCLI = .init(
                prefix: ["/profile/runtime/build/bin/bun", "/profile/runtime/build/lib/openclaw.mjs"],
                sqliteLibrary: nil)
            manager.storeHosting(.app)
            #expect(manager.retainedServiceCLI == nil)
            #expect(AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) == nil)
            #expect(AppDefaults.standard.string(forKey: GatewayHosting.defaultsKey) == "app")
        }
    }

    @Test func `paused owned Bun permits hosting changes while retained external and Node runtimes do not`() {
        let state = URL(fileURLWithPath: "/profile")
        for (runtime, entrypoint, available) in [
            ("/profile/runtime/build/bin/bun", "/profile/runtime/build/lib/openclaw.mjs", true),
            ("/profile/runtime/build/bin/bun", "/profile/lib/node_modules/openclaw/openclaw.mjs", false),
            ("/operator/bun", "/profile/runtime/build/lib/openclaw.mjs", false),
            ("/operator/node", "/profile/lib/node_modules/openclaw/openclaw.mjs", false),
            ("/profile/tools/node/bin/node", "/profile/lib/node_modules/openclaw/openclaw.mjs", false),
        ] {
            let cli = GatewayLaunchAgentManager.InstalledServiceCLI(
                prefix: [runtime, entrypoint], sqliteLibrary: nil)
            #expect(GatewayHosting.canChangeHosting(
                hasService: false,
                installedCLI: nil,
                retainedCLI: cli,
                hasRetainedMetadata: true,
                stateDirectory: state) == available)
        }
        #expect(!GatewayHosting.canChangeHosting(
            hasService: false,
            installedCLI: nil,
            retainedCLI: nil,
            hasRetainedMetadata: true,
            stateDirectory: state))
    }

    struct Fixture: Sendable {
        let stored: String?
        let bundled: Bool
        let serviceExists: Bool
        let expected: GatewayHosting
    }

    @Test(arguments: [
        Fixture(stored: nil, bundled: true, serviceExists: false, expected: .app),
        Fixture(stored: nil, bundled: true, serviceExists: true, expected: .service),
        Fixture(stored: "app", bundled: true, serviceExists: true, expected: .service),
        Fixture(stored: "app", bundled: true, serviceExists: false, expected: .app),
        Fixture(stored: "service", bundled: true, serviceExists: false, expected: .service),
        Fixture(stored: "unknown", bundled: true, serviceExists: false, expected: .app),
        Fixture(stored: "unknown", bundled: true, serviceExists: true, expected: .service),
        Fixture(stored: nil, bundled: false, serviceExists: false, expected: .service),
        Fixture(stored: nil, bundled: false, serviceExists: true, expected: .service),
        Fixture(stored: "app", bundled: false, serviceExists: false, expected: .service),
        Fixture(stored: "service", bundled: false, serviceExists: true, expected: .service),
    ])
    func `hosting preserves existing service intent while fresh bundled profiles use the app`(_ fixture: Fixture) {
        #expect(GatewayHosting.resolve(
            stored: fixture.stored,
            bundled: fixture.bundled,
            serviceExists: fixture.serviceExists) == fixture.expected)
    }
}
