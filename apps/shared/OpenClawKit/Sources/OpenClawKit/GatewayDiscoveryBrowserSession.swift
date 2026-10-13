import Foundation
import Network

@MainActor
public final class GatewayDiscoveryBrowserSession {
    private var browsers: [String: NWBrowser] = [:]
    private var states: [String: NWBrowser.State] = [:]
    private var generation: UInt64 = 0

    public init() {}

    public var isRunning: Bool {
        !self.browsers.isEmpty
    }

    public func start(
        queueLabelPrefix: String,
        onState: @escaping @MainActor (String, NWBrowser.State, String) -> Void,
        onResults: @escaping @MainActor (String, Set<NWBrowser.Result>) -> Void)
    {
        guard !self.isRunning else { return }
        self.generation &+= 1
        let generation = self.generation
        for domain in OpenClawBonjour.gatewayServiceDomains {
            let parameters = NWParameters.tcp
            parameters.includePeerToPeer = true
            let browser = NWBrowser(
                for: .bonjour(type: OpenClawBonjour.gatewayServiceType, domain: domain),
                using: parameters)
            browser.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self, self.generation == generation else { return }
                    self.states[domain] = state
                    let status = GatewayDiscoveryStatusText.make(
                        states: Array(self.states.values), hasBrowsers: self.isRunning)
                    onState(domain, state, status)
                }
            }
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                Task { @MainActor in
                    guard let self, self.generation == generation else { return }
                    onResults(domain, results)
                }
            }
            browser.start(queue: DispatchQueue(label: "\(queueLabelPrefix).\(domain)"))
            self.browsers[domain] = browser
        }
    }

    public func stop() {
        self.generation &+= 1
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.states = [:]
    }
}
