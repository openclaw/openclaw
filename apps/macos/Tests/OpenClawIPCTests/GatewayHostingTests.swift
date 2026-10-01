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
