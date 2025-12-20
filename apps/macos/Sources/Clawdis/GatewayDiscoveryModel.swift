import ClawdisKit
import Foundation
import Network
import Observation

@MainActor
@Observable
final class GatewayDiscoveryModel {
    struct LocalIdentity: Equatable {
        var hostTokens: Set<String>
        var displayTokens: Set<String>
    }

    struct DiscoveredGateway: Identifiable, Equatable {
        var id: String { self.stableID }
        var displayName: String
        var lanHost: String?
        var tailnetDns: String?
        var sshPort: Int
        var stableID: String
        var debugID: String
        var isLocal: Bool
    }

    var gateways: [DiscoveredGateway] = []
    var statusText: String = "Idle"

    private var browsers: [String: NWBrowser] = [:]
    private var gatewaysByDomain: [String: [DiscoveredGateway]] = [:]
    private var statesByDomain: [String: NWBrowser.State] = [:]
    private let localIdentity: LocalIdentity = GatewayDiscoveryModel.buildLocalIdentity()

    func start() {
        if !self.browsers.isEmpty { return }

        for domain in ClawdisBonjour.bridgeServiceDomains {
            let params = NWParameters.tcp
            params.includePeerToPeer = true
            let browser = NWBrowser(
                for: .bonjour(type: ClawdisBonjour.bridgeServiceType, domain: domain),
                using: params)

            browser.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    self.statesByDomain[domain] = state
                    self.updateStatusText()
                }
            }

            browser.browseResultsChangedHandler = { [weak self] results, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.gatewaysByDomain[domain] = results.compactMap { result -> DiscoveredGateway? in
                        guard case let .service(name, _, _, _) = result.endpoint else { return nil }

                        let decodedName = BonjourEscapes.decode(name)
                        let txt = Self.txtDictionary(from: result)

                        let advertisedName = txt["displayName"]
                            .map(Self.prettifyInstanceName)
                            .flatMap { $0.isEmpty ? nil : $0 }
                        let prettyName =
                            advertisedName ?? Self.prettifyServiceName(decodedName)

                        var lanHost: String?
                        var tailnetDns: String?
                        var sshPort = 22

                        if let value = txt["lanHost"] {
                            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                            lanHost = trimmed.isEmpty ? nil : trimmed
                        }
                        if let value = txt["tailnetDns"] {
                            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                            tailnetDns = trimmed.isEmpty ? nil : trimmed
                        }
                        if let value = txt["sshPort"],
                           let parsed = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)),
                           parsed > 0
                        {
                            sshPort = parsed
                        }

                        let isLocal = Self.isLocalGateway(
                            lanHost: lanHost,
                            tailnetDns: tailnetDns,
                            displayName: prettyName,
                            serviceName: decodedName,
                            local: self.localIdentity)
                        return DiscoveredGateway(
                            displayName: prettyName,
                            lanHost: lanHost,
                            tailnetDns: tailnetDns,
                            sshPort: sshPort,
                            stableID: BridgeEndpointID.stableID(result.endpoint),
                            debugID: BridgeEndpointID.prettyDescription(result.endpoint),
                            isLocal: isLocal)
                    }
                    .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

                    self.recomputeGateways()
                }
            }

            self.browsers[domain] = browser
            browser.start(queue: DispatchQueue(label: "com.steipete.clawdis.macos.gateway-discovery.\(domain)"))
        }
    }

    func stop() {
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.gatewaysByDomain = [:]
        self.statesByDomain = [:]
        self.gateways = []
        self.statusText = "Stopped"
    }

    private func recomputeGateways() {
        self.gateways = self.gatewaysByDomain.values
            .flatMap(\.self)
            .filter { !$0.isLocal }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private func updateStatusText() {
        let states = Array(self.statesByDomain.values)
        if states.isEmpty {
            self.statusText = self.browsers.isEmpty ? "Idle" : "Setup"
            return
        }

        if let failed = states.first(where: { state in
            if case .failed = state { return true }
            return false
        }) {
            if case let .failed(err) = failed {
                self.statusText = "Failed: \(err)"
                return
            }
        }

        if let waiting = states.first(where: { state in
            if case .waiting = state { return true }
            return false
        }) {
            if case let .waiting(err) = waiting {
                self.statusText = "Waiting: \(err)"
                return
            }
        }

        if states.contains(where: { if case .ready = $0 { true } else { false } }) {
            self.statusText = "Searching…"
            return
        }

        if states.contains(where: { if case .setup = $0 { true } else { false } }) {
            self.statusText = "Setup"
            return
        }

        self.statusText = "Searching…"
    }

    private static func txtDictionary(from result: NWBrowser.Result) -> [String: String] {
        guard case let .bonjour(txt) = result.metadata else { return [:] }
        return txt.dictionary
    }

    private static func prettifyInstanceName(_ decodedName: String) -> String {
        let normalized = decodedName.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let stripped = normalized.replacingOccurrences(of: " (Clawdis)", with: "")
            .replacingOccurrences(of: #"\s+\(\d+\)$"#, with: "", options: .regularExpression)
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func prettifyServiceName(_ decodedName: String) -> String {
        let normalized = Self.prettifyInstanceName(decodedName)
        var cleaned = normalized.replacingOccurrences(of: #"\s*-?bridge$"#, with: "", options: .regularExpression)
        cleaned = cleaned
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty {
            cleaned = normalized
        }
        let words = cleaned.split(separator: " ")
        let titled = words.map { word -> String in
            let lower = word.lowercased()
            guard let first = lower.first else { return "" }
            return String(first).uppercased() + lower.dropFirst()
        }.joined(separator: " ")
        return titled.isEmpty ? normalized : titled
    }

    static func isLocalGateway(
        lanHost: String?,
        tailnetDns: String?,
        displayName: String?,
        serviceName: String?,
        local: LocalIdentity) -> Bool
    {
        if let host = normalizeHostToken(lanHost),
           local.hostTokens.contains(host)
        {
            return true
        }
        if let host = normalizeHostToken(tailnetDns),
           local.hostTokens.contains(host)
        {
            return true
        }
        if let name = normalizeDisplayToken(displayName),
           local.displayTokens.contains(name)
        {
            return true
        }
        if let service = normalizeServiceToken(serviceName) {
            for token in local.hostTokens {
                if service.contains(token) {
                    return true
                }
            }
        }
        return false
    }

    private static func buildLocalIdentity() -> LocalIdentity {
        var hostTokens: Set<String> = []
        var displayTokens: Set<String> = []

        let hostName = ProcessInfo.processInfo.hostName
        if let token = normalizeHostToken(hostName) {
            hostTokens.insert(token)
        }
        if let host = Host.current().name,
           let token = normalizeHostToken(host)
        {
            hostTokens.insert(token)
        }

        let displayCandidates = [
            Host.current().localizedName,
            InstanceIdentity.displayName,
        ]
        for raw in displayCandidates {
            if let token = normalizeDisplayToken(raw) {
                displayTokens.insert(token)
            }
        }

        return LocalIdentity(hostTokens: hostTokens, displayTokens: displayTokens)
    }

    private static func normalizeHostToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let lower = trimmed.lowercased()
        let strippedTrailingDot = lower.hasSuffix(".")
            ? String(lower.dropLast())
            : lower
        let withoutLocal = strippedTrailingDot.hasSuffix(".local")
            ? String(strippedTrailingDot.dropLast(6))
            : strippedTrailingDot
        let firstLabel = withoutLocal.split(separator: ".").first.map(String.init)
        let token = (firstLabel ?? withoutLocal).trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    private static func normalizeDisplayToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let prettified = Self.prettifyInstanceName(raw)
        let trimmed = prettified.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return trimmed.lowercased()
    }

    private static func normalizeServiceToken(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return trimmed.lowercased()
    }
}
