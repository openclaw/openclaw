import Foundation

public struct ShareGatewayRelayConfig: Codable, Sendable, Equatable {
    public let gatewayURLString: String
    public let token: String?
    public let password: String?
    public let sessionKey: String
    public let deliveryChannel: String?
    public let deliveryTo: String?

    public init(
        gatewayURLString: String,
        token: String?,
        password: String?,
        sessionKey: String,
        deliveryChannel: String? = nil,
        deliveryTo: String? = nil)
    {
        self.gatewayURLString = gatewayURLString
        self.token = token
        self.password = password
        self.sessionKey = sessionKey
        self.deliveryChannel = deliveryChannel
        self.deliveryTo = deliveryTo
    }
}

public enum ShareGatewayRelaySettings {
    private static let suiteName = "group.ai.vericlaw.shared"
    private static let legacySuiteName = "group.ai.openclaw.shared"
    private static let relayConfigKey = "share.gatewayRelay.config.v1"
    private static let lastEventKey = "share.gatewayRelay.event.v1"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: self.suiteName) ?? .standard
    }

    private static var legacyDefaults: UserDefaults? {
        UserDefaults(suiteName: self.legacySuiteName)
    }

    public static func loadConfig() -> ShareGatewayRelayConfig? {
        if let data = self.defaults.data(forKey: self.relayConfigKey) {
            return try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data)
        }
        guard let data = self.legacyDefaults?.data(forKey: self.relayConfigKey),
              let decoded = try? JSONDecoder().decode(ShareGatewayRelayConfig.self, from: data)
        else { return nil }
        self.saveConfig(decoded)
        self.legacyDefaults?.removeObject(forKey: self.relayConfigKey)
        return decoded
    }

    public static func saveConfig(_ config: ShareGatewayRelayConfig) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        self.defaults.set(data, forKey: self.relayConfigKey)
        self.legacyDefaults?.removeObject(forKey: self.relayConfigKey)
    }

    public static func clearConfig() {
        self.defaults.removeObject(forKey: self.relayConfigKey)
        self.legacyDefaults?.removeObject(forKey: self.relayConfigKey)
    }

    public static func saveLastEvent(_ message: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let payload = "[\(timestamp)] \(message)"
        self.defaults.set(payload, forKey: self.lastEventKey)
    }

    public static func loadLastEvent() -> String? {
        let value = (
            self.defaults.string(forKey: self.lastEventKey)
                ?? self.legacyDefaults?.string(forKey: self.lastEventKey)
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? nil : value
    }
}
