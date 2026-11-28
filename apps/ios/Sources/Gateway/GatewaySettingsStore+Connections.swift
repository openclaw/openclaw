import Foundation
import Network
import OpenClawKit

extension GatewaySettingsStore {
    struct GatewayRegistry: Codable, Equatable {
        var version: Int = 1
        var activeStableID: String?
        /// Gateways whose operator sessions should stay live. `activeStableID`
        /// is only the UI focus and does not imply exclusive connectivity.
        var connectedStableIDs: [String] = []
        var entries: [GatewayRegistryEntry] = []

        static let empty = GatewayRegistry()

        var activeEntry: GatewayRegistryEntry? {
            guard let activeStableID else { return nil }
            return self.entries.first { GatewayStableIdentifier.matches($0.stableID, activeStableID) }
        }

        /// The endpoint is secondary in the picker, but a compact single-line label elsewhere.
        func distinguishingAddress(for entry: GatewayRegistryEntry) -> String? {
            guard let host = entry.host, let port = entry.port else { return nil }
            let matches = self.entries.filter {
                $0.id != entry.id && $0.displayName.localizedCaseInsensitiveCompare(entry.displayName) == .orderedSame
            }
            guard !matches.isEmpty else { return nil }
            if matches.allSatisfy({ $0.host?.caseInsensitiveCompare(host) == .orderedSame }) {
                return String(format: String(localized: "Port %@"), String(port))
            }
            return matches.contains { $0.host?.caseInsensitiveCompare(host) == .orderedSame }
                ? "\(host):\(port)" : host
        }

        func compactName(for entry: GatewayRegistryEntry) -> String {
            guard let host = entry.host, let port = entry.port,
                  self.entries.contains(where: {
                      $0.id != entry.id && $0.host?.caseInsensitiveCompare(host) == .orderedSame &&
                          $0.displayName.localizedCaseInsensitiveCompare(entry.displayName) == .orderedSame
                  }) else { return entry.displayName }
            return "\(entry.displayName):\(port)"
        }

        mutating func activate(stableID: String) {
            self.activeStableID = stableID
            if !self.connectedStableIDs.contains(where: { GatewayStableIdentifier.matches($0, stableID) }) {
                self.connectedStableIDs.append(stableID)
            }
        }
    }

    /// Apply the reported name only to an untouched address; a rename can happen while the RPC is in flight.
    @discardableResult
    static func setGatewayName(_ name: String, stableID: String, onlyIfAutomatic: Bool = false) -> Bool {
        guard let name = name.trimmedNonEmpty else { return false }
        var registry = self.loadGatewayRegistry()
        guard let index = registry.entries
            .firstIndex(where: { GatewayStableIdentifier.matches($0.stableID, stableID) }),
            !onlyIfAutomatic || registry.entries[index].hasAutomaticAddressName
        else { return false }
        registry.entries[index].name = name
        return self.saveGatewayRegistry(registry)
    }

    @discardableResult
    static func setActiveGateway(stableID: String) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        guard let storedID = registry.entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        })?.stableID else { return false }
        registry.activate(stableID: storedID)
        return self.saveGatewayRegistry(registry)
    }

    @discardableResult
    static func setGatewayConnectionEnabled(stableID: String, enabled: Bool) -> Bool {
        guard let stableID = GatewayStableIdentifier.exact(stableID) else { return false }
        var registry = self.loadGatewayRegistry()
        guard let storedID = registry.entries.first(where: {
            GatewayStableIdentifier.matches($0.stableID, stableID)
        })?.stableID else { return false }
        registry.connectedStableIDs.removeAll {
            GatewayStableIdentifier.matches($0, storedID)
        }
        if enabled {
            registry.connectedStableIDs.append(storedID)
        }
        return self.saveGatewayRegistry(registry)
    }
}

extension GatewaySettingsStore.GatewayRegistryEntry {
    var hasAutomaticAddressName: Bool {
        guard self.kind == .manual, let host = self.host, let port = self.port else { return false }
        return self.name.isEmpty || self.name.caseInsensitiveCompare("\(host):\(port)") == .orderedSame
    }

    var displayName: String {
        guard self.hasAutomaticAddressName, let host = self.host else { return self.name }
        // Keep literal addresses recognizable; the first octet alone is not a name.
        if IPv4Address(host) != nil || host.contains(":") { return host }
        return host.split(separator: ".").first.map(String.init) ?? host
    }
}

extension GatewaySettingsStore.GatewayRegistry {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let version = try values.decode(Int.self, forKey: .version)
        let activeStableID = try values.decodeIfPresent(String.self, forKey: .activeStableID)
        self.version = version
        self.activeStableID = activeStableID
        self.connectedStableIDs = try values.decodeIfPresent(
            [String].self,
            forKey: .connectedStableIDs) ?? (version == 1 ? activeStableID.map { [$0] } ?? [] : [])
        self.entries = try values.decodeIfPresent(
            [GatewaySettingsStore.GatewayRegistryEntry].self,
            forKey: .entries) ?? []
    }
}
