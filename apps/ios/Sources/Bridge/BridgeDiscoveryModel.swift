import ClawdisKit
import Foundation
import Network

@MainActor
final class BridgeDiscoveryModel: ObservableObject {
    struct DiscoveredBridge: Identifiable, Equatable {
        var id: String { self.stableID }
        var name: String
        var endpoint: NWEndpoint
        var stableID: String
        var debugID: String
    }

    @Published var bridges: [DiscoveredBridge] = []
    @Published var statusText: String = "Idle"

    private var browser: NWBrowser?

    func start() {
        if self.browser != nil { return }
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: ClawdisBonjour.bridgeServiceType, domain: ClawdisBonjour.bridgeServiceDomain),
            using: params)

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .setup:
                    self.statusText = "Setup"
                case .ready:
                    self.statusText = "Searching…"
                case let .failed(err):
                    self.statusText = "Failed: \(err)"
                case .cancelled:
                    self.statusText = "Stopped"
                case let .waiting(err):
                    self.statusText = "Waiting: \(err)"
                @unknown default:
                    self.statusText = "Unknown"
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                self.bridges = results.compactMap { result -> DiscoveredBridge? in
                    switch result.endpoint {
                    case let .service(name, _, _, _):
                        let decodedName = BonjourEscapes.decode(name)
                        return DiscoveredBridge(
                            name: decodedName,
                            endpoint: result.endpoint,
                            stableID: BridgeEndpointID.stableID(result.endpoint),
                            debugID: BridgeEndpointID.prettyDescription(result.endpoint))
                    default:
                        return nil
                    }
                }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }
        }

        self.browser = browser
        browser.start(queue: DispatchQueue(label: "com.steipete.clawdis.ios.bridge-discovery"))
    }

    func stop() {
        self.browser?.cancel()
        self.browser = nil
        self.bridges = []
        self.statusText = "Stopped"
    }
}
