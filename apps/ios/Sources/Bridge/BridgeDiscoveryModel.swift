import ClawdisKit
import Foundation
import Network
import Observation

@MainActor
@Observable
final class BridgeDiscoveryModel {
    struct DebugLogEntry: Identifiable, Equatable {
        var id = UUID()
        var ts: Date
        var message: String
    }

    struct DiscoveredBridge: Identifiable, Equatable {
        var id: String { self.stableID }
        var name: String
        var endpoint: NWEndpoint
        var stableID: String
        var debugID: String
    }

    var bridges: [DiscoveredBridge] = []
    var statusText: String = "Idle"
    private(set) var debugLog: [DebugLogEntry] = []

    private var browser: NWBrowser?
    private var debugLoggingEnabled = false
    private var lastStableIDs = Set<String>()
    private var serviceDomain: String = ClawdisBonjour.bridgeServiceDomain

    func setDebugLoggingEnabled(_ enabled: Bool) {
        let wasEnabled = self.debugLoggingEnabled
        self.debugLoggingEnabled = enabled
        if !enabled {
            self.debugLog = []
        } else if !wasEnabled {
            self.appendDebugLog("debug logging enabled")
            self.appendDebugLog("snapshot: status=\(self.statusText) bridges=\(self.bridges.count)")
        }
    }

    func setServiceDomain(_ domain: String?) {
        let normalized = ClawdisBonjour.normalizeServiceDomain(domain)
        guard normalized != self.serviceDomain else { return }
        self.appendDebugLog("service domain: \(self.serviceDomain) → \(normalized)")
        self.serviceDomain = normalized

        if self.browser != nil {
            self.stop()
            self.start()
        }
    }

    func start() {
        if self.browser != nil { return }
        self.appendDebugLog("start()")
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: ClawdisBonjour.bridgeServiceType, domain: self.serviceDomain),
            using: params)

        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .setup:
                    self.statusText = "Setup"
                    self.appendDebugLog("state: setup")
                case .ready:
                    self.statusText = "Searching…"
                    self.appendDebugLog("state: ready")
                case let .failed(err):
                    self.statusText = "Failed: \(err)"
                    self.appendDebugLog("state: failed (\(err))")
                    self.browser?.cancel()
                    self.browser = nil
                case .cancelled:
                    self.statusText = "Stopped"
                    self.appendDebugLog("state: cancelled")
                    self.browser = nil
                case let .waiting(err):
                    self.statusText = "Waiting: \(err)"
                    self.appendDebugLog("state: waiting (\(err))")
                @unknown default:
                    self.statusText = "Unknown"
                    self.appendDebugLog("state: unknown")
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                let next = results.compactMap { result -> DiscoveredBridge? in
                    switch result.endpoint {
                    case let .service(name, _, _, _):
                        let decodedName = BonjourEscapes.decode(name)
                        let advertisedName = result.endpoint.txtRecord?.dictionary["displayName"]
                        let prettyAdvertised = advertisedName
                            .map(Self.prettifyInstanceName)
                            .flatMap { $0.isEmpty ? nil : $0 }
                        let prettyName = prettyAdvertised ?? Self.prettifyInstanceName(decodedName)
                        return DiscoveredBridge(
                            name: prettyName,
                            endpoint: result.endpoint,
                            stableID: BridgeEndpointID.stableID(result.endpoint),
                            debugID: BridgeEndpointID.prettyDescription(result.endpoint))
                    default:
                        return nil
                    }
                }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

                let nextIDs = Set(next.map(\.stableID))
                let added = nextIDs.subtracting(self.lastStableIDs)
                let removed = self.lastStableIDs.subtracting(nextIDs)
                if !added.isEmpty || !removed.isEmpty {
                    self.appendDebugLog(
                        "results: total=\(next.count) added=\(added.count) removed=\(removed.count)")
                }
                self.lastStableIDs = nextIDs
                self.bridges = next
            }
        }

        self.browser = browser
        browser.start(queue: DispatchQueue(label: "com.steipete.clawdis.ios.bridge-discovery"))
    }

    func stop() {
        self.appendDebugLog("stop()")
        self.browser?.cancel()
        self.browser = nil
        self.bridges = []
        self.statusText = "Stopped"
    }

    private func appendDebugLog(_ message: String) {
        guard self.debugLoggingEnabled else { return }
        self.debugLog.append(DebugLogEntry(ts: Date(), message: message))
        if self.debugLog.count > 200 {
            self.debugLog.removeFirst(self.debugLog.count - 200)
        }
    }

    private static func prettifyInstanceName(_ decodedName: String) -> String {
        let normalized = decodedName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let stripped = normalized.replacingOccurrences(of: " (Clawdis)", with: "")
            .replacingOccurrences(of: #"\s+\(\d+\)$"#, with: "", options: .regularExpression)
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
