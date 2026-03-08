import Testing
@testable import OpenClaw

@Suite struct RootCanvasPresentationTests {
    @Test func quickSetupDoesNotPresentWhenGatewayAlreadyConfigured() {
        let shouldPresent = RootCanvas.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: true,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func quickSetupPresentsForFreshInstallWithDiscoveredGateway() {
        let shouldPresent = RootCanvas.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(shouldPresent)
    }

    @Test func quickSetupDoesNotPresentWhenAlreadyConnected() {
        let shouldPresent = RootCanvas.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: true,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }
}
