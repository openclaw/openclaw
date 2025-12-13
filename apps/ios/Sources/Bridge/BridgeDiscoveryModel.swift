import ClawdisKit
import Foundation
import Network

@MainActor
final class BridgeDiscoveryModel: ObservableObject {
    struct DiscoveredBridge: Identifiable, Equatable {
        var id: String { self.debugID }
        var name: String
        var endpoint: NWEndpoint
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
                        return DiscoveredBridge(
                            name: name,
                            endpoint: result.endpoint,
                            debugID: Self.prettyEndpointDebugID(result.endpoint))
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

    private static func prettyEndpointDebugID(_ endpoint: NWEndpoint) -> String {
        self.decodeBonjourEscapes(String(describing: endpoint))
    }

    private static func decodeBonjourEscapes(_ input: String) -> String {
        // mDNS / DNS-SD commonly escapes spaces as `\\032` (decimal byte value 32). Make this human-friendly for UI.
        var out = ""
        var i = input.startIndex
        while i < input.endIndex {
            if input[i] == "\\",
               let d0 = input.index(i, offsetBy: 1, limitedBy: input.index(before: input.endIndex)),
               let d1 = input.index(i, offsetBy: 2, limitedBy: input.index(before: input.endIndex)),
               let d2 = input.index(i, offsetBy: 3, limitedBy: input.index(before: input.endIndex)),
               input[d0].isNumber,
               input[d1].isNumber,
               input[d2].isNumber
            {
                let digits = String(input[d0...d2])
                if let value = Int(digits),
                   let scalar = UnicodeScalar(value)
                {
                    out.append(Character(scalar))
                    i = input.index(i, offsetBy: 4)
                    continue
                }
            }

            out.append(input[i])
            i = input.index(after: i)
        }
        return out
    }
}
