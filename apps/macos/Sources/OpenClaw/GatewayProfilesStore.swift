import Foundation
import Observation

struct GatewayProfile: Codable, Equatable, Identifiable {
    let id: String
    var name: String
    var host: String
    var port: Int
    var accessToken: String
    var createdAtMs: Double
    var updatedAtMs: Double

    var endpointLabel: String {
        "\(self.host):\(self.port)"
    }

    var websocketURL: URL? {
        let raw = GatewayDiscoveryHelpers.directGatewayUrl(serviceHost: self.host, servicePort: self.port)
            ?? "wss://\(self.host):\(self.port)"
        return URL(string: raw)
    }
}

@MainActor
@Observable
final class GatewayProfilesStore {
    static let shared = GatewayProfilesStore()

    var profiles: [GatewayProfile] = []
    var selectedProfileID: String?

    private static let profilesKey = "openclaw.gatewayProfiles"
    private static let selectedProfileKey = "openclaw.gatewayProfile.selected"

    init(defaults: UserDefaults = .standard) {
        self.load(defaults: defaults)
    }

    func upsert(host rawHost: String, port: Int, accessToken rawToken: String, name rawName: String?) -> GatewayProfile {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let suppliedName = rawName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = suppliedName.isEmpty ? host : suppliedName
        let now = Date().timeIntervalSince1970 * 1000

        if let index = self.profiles.firstIndex(where: { $0.host == host && $0.port == port }) {
            var existing = self.profiles[index]
            existing.name = name
            existing.accessToken = token
            existing.updatedAtMs = now
            self.profiles[index] = existing
            self.persist()
            return existing
        }

        let profile = GatewayProfile(
            id: UUID().uuidString,
            name: name,
            host: host,
            port: port,
            accessToken: token,
            createdAtMs: now,
            updatedAtMs: now)
        self.profiles.append(profile)
        self.profiles.sort { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
        self.persist()
        return profile
    }

    func remove(profileID: String) {
        self.profiles.removeAll { $0.id == profileID }
        if self.selectedProfileID == profileID {
            self.selectedProfileID = nil
        }
        self.persist()
    }

    func apply(profile: GatewayProfile, to state: AppState) {
        state.connectionMode = .remote
        state.remoteTransport = .direct
        state.remoteUrl = GatewayProfilesStore.makeDirectURL(host: profile.host, port: profile.port)
        state.remoteToken = profile.accessToken
        state.remoteTarget = "\(NSUserName())@\(profile.host)"
        self.selectedProfileID = profile.id
        self.persist()
    }

    private static func makeDirectURL(host: String, port: Int) -> String {
        if let url = GatewayDiscoveryHelpers.directGatewayUrl(serviceHost: host, servicePort: port) {
            return url
        }
        return "wss://\(host):\(port)"
    }

    private func load(defaults: UserDefaults = .standard) {
        if let data = defaults.data(forKey: Self.profilesKey),
           let decoded = try? JSONDecoder().decode([GatewayProfile].self, from: data)
        {
            self.profiles = decoded
        } else {
            self.profiles = []
        }
        let selected = defaults.string(forKey: Self.selectedProfileKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self.selectedProfileID = selected?.isEmpty == false ? selected : nil
    }

    private func persist(defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self.profiles) {
            defaults.set(data, forKey: Self.profilesKey)
        }
        if let selectedProfileID, !selectedProfileID.isEmpty {
            defaults.set(selectedProfileID, forKey: Self.selectedProfileKey)
        } else {
            defaults.removeObject(forKey: Self.selectedProfileKey)
        }
    }
}
