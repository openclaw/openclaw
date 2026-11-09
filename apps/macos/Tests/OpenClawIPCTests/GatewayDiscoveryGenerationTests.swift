import Network
import OpenClawKit
import Testing
@testable import OpenClawDiscovery

@MainActor
struct GatewayDiscoveryGenerationTests {
    @Test func stoppedAndRestartedDiscoveryIgnoresOldBrowserCallbacks() throws {
        let browser = RetainedDiscoveryBrowser()
        let model = GatewayDiscoveryModel(
            localDisplayName: "Generation fixture",
            filterLocalGateways: false,
            browserSession: browser)
        defer { model.stop() }

        model.start()
        model.start()
        try #require(browser.handlers.count == 1)
        let old = browser.handlers[0]
        old.onState("local.", .ready, "First search")
        #expect(model.statusText == "First search")

        model.stop()
        old.onState("local.", .cancelled, "Late cancellation")
        #expect(model.statusText == GatewayDiscoveryStatusText.stopped)
        #expect(model.gateways.isEmpty)

        model.start()
        try #require(browser.handlers.count == 2)
        let current = browser.handlers[1]
        current.onState("local.", .ready, "Second search")

        // Seed the existing public projection without private Network results or a resolver.
        // An old empty result must not clear the newer generation's published state.
        let gateway = GatewayDiscoveryModel.DiscoveredGateway(
            displayName: "Current gateway",
            sshPort: 22,
            stableID: "current",
            debugID: "current",
            isLocal: false)
        model.gateways = [gateway]
        old.onState("local.", .ready, "Old search")
        old.onResults("local.", [])
        #expect(model.statusText == "Second search")
        #expect(model.gateways == [gateway])

        // Positive control: the current callback must still update the real projection.
        current.onResults("local.", [])
        #expect(model.gateways.isEmpty)
    }
}

@MainActor
private final class RetainedDiscoveryBrowser: GatewayDiscoveryBrowsing {
    struct Handlers {
        var onState: @MainActor (String, NWBrowser.State, String) -> Void
        var onResults: @MainActor (String, Set<NWBrowser.Result>) -> Void
    }

    var isRunning = false
    var handlers: [Handlers] = []

    func start(
        queueLabelPrefix _: String,
        onState: @escaping @MainActor (String, NWBrowser.State, String) -> Void,
        onResults: @escaping @MainActor (String, Set<NWBrowser.Result>) -> Void)
    {
        self.isRunning = true
        self.handlers.append(Handlers(onState: onState, onResults: onResults))
    }

    func stop() {
        self.isRunning = false
        // Network callbacks already enqueued on MainActor can outlive cancellation.
    }
}
