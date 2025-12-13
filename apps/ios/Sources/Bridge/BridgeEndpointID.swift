import ClawdisKit
import Foundation
import Network

enum BridgeEndpointID {
    static func stableID(_ endpoint: NWEndpoint) -> String {
        switch endpoint {
        case let .service(name, type, domain, _):
            // Keep this stable across encode/decode differences; use raw service tuple.
            "\(type)|\(domain)|\(name)"
        default:
            String(describing: endpoint)
        }
    }

    static func prettyDescription(_ endpoint: NWEndpoint) -> String {
        BonjourEscapes.decode(String(describing: endpoint))
    }
}
