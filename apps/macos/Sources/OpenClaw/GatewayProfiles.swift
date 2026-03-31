import Foundation
import OpenClawKit

struct GatewayProfile: Identifiable, Hashable {
    enum Kind: String, Hashable {
        case local
        case remoteDirect
    }

    let id: String
    let kind: Kind
    let name: String
    let url: URL
    let token: String?

    var displayName: String { self.name }

    static func local() -> GatewayProfile {
        let config = GatewayEndpointStore.localConfig()
        return GatewayProfile(
            id: "local",
            kind: .local,
            name: "Local gateway",
            url: config.url,
            token: config.token)
    }

    static func remoteDirect(from saved: AppState.SavedRemoteGateway) -> GatewayProfile? {
        let host = saved.host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        let port = Int(saved.port.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 443
        guard let url = GatewayRemoteConfig.normalizeGatewayUrl("wss://\(host):\(port)") else { return nil }
        let trimmedToken = saved.token.trimmingCharacters(in: .whitespacesAndNewlines)
        return GatewayProfile(
            id: "remote-direct:\(saved.id.uuidString)",
            kind: .remoteDirect,
            name: saved.displayName,
            url: url,
            token: trimmedToken.isEmpty ? nil : trimmedToken)
    }
}

actor GatewayChatConnectionRegistry {
    static let shared = GatewayChatConnectionRegistry()

    private var connections: [String: GatewayConnection] = [:]

    func connection(for profile: GatewayProfile) -> GatewayConnection {
        if let existing = self.connections[profile.id] { return existing }
        let config: GatewayConnection.Config = (url: profile.url, token: profile.token, password: nil)
        let connection = GatewayConnection(configProvider: { config })
        self.connections[profile.id] = connection
        return connection
    }
}
