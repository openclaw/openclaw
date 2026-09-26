import Foundation
import Network

public enum GatewayDiscoveryStatusText {
    public static var idle: String {
        String(localized: "Idle")
    }

    public static var stopped: String {
        String(localized: "Stopped")
    }

    public static func make(states: [NWBrowser.State], hasBrowsers: Bool) -> String {
        if states.isEmpty {
            return hasBrowsers ? String(localized: "Setup") : self.idle
        }

        for case let .failed(err) in states {
            return "\(String(localized: "Failed")): \(err)"
        }

        for case let .waiting(err) in states {
            return "\(String(localized: "Waiting")): \(err)"
        }

        if states.contains(where: {
            if case .ready = $0 {
                true
            } else {
                false
            }
        }) {
            return String(localized: "Searching…")
        }

        if states.contains(where: {
            if case .setup = $0 {
                true
            } else {
                false
            }
        }) {
            return String(localized: "Setup")
        }

        return String(localized: "Searching…")
    }
}
