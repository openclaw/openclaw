import CryptoKit
import Foundation

enum EffectiveConnectionModeSource: Equatable {
    case configMode
    case configRemoteURL
    case userDefaults
    case onboarding
    case deferredPrimary
}

struct EffectiveConnectionMode: Equatable {
    let mode: AppState.ConnectionMode
    let source: EffectiveConnectionModeSource
}

enum ConnectionModeResolver {
    static func resolve(
        root: [String: Any],
        defaults: UserDefaults = AppDefaults.standard) -> EffectiveConnectionMode
    {
        if self.primaryGatewayIsDeferred(root: root, defaults: defaults) {
            return EffectiveConnectionMode(mode: .unconfigured, source: .deferredPrimary)
        }

        let gateway = root["gateway"] as? [String: Any]
        let configModeRaw = (gateway?["mode"] as? String) ?? ""
        let configMode = configModeRaw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch configMode {
        case "local":
            return EffectiveConnectionMode(mode: .local, source: .configMode)
        case "remote":
            return EffectiveConnectionMode(mode: .remote, source: .configMode)
        default:
            break
        }

        if GatewayRemoteConfig.resolveUrlString(root: root) != nil {
            return EffectiveConnectionMode(mode: .remote, source: .configRemoteURL)
        }

        if let storedModeRaw = defaults.string(forKey: connectionModeKey) {
            let storedMode = AppState.ConnectionMode(rawValue: storedModeRaw) ?? .local
            return EffectiveConnectionMode(mode: storedMode, source: .userDefaults)
        }

        let seen = defaults.bool(forKey: "openclaw.onboardingSeen")
        return EffectiveConnectionMode(mode: seen ? .local : .unconfigured, source: .onboarding)
    }

    /// "Set up later" is recorded in the app's own defaults, never in `openclaw.json`: the file's
    /// `gateway.mode` belongs to whichever Gateway runs from it, and the Gateway refuses to start
    /// without it. The record carries the `gateway` section's fingerprint, so an edit by any other
    /// writer (CLI onboarding, `config set gateway.mode`) retires the deferral and the file wins again.
    static func primaryGatewayIsDeferred(
        root: [String: Any],
        defaults: UserDefaults = AppDefaults.standard) -> Bool
    {
        guard let deferred = defaults.data(forKey: primaryGatewayDeferredFingerprintKey) else { return false }
        return deferred == self.gatewayRoutingFingerprint(root)
    }

    /// SHA-256 of the canonical `gateway` section. A digest, never the JSON: the section carries
    /// Gateway credentials and the deferral record lands in the app's defaults.
    static func gatewayRoutingFingerprint(_ root: [String: Any]) -> Data? {
        let comparable: [String: Any] = ["gateway": root["gateway"] ?? [:]]
        guard JSONSerialization.isValidJSONObject(comparable),
              let json = try? JSONSerialization.data(withJSONObject: comparable, options: [.sortedKeys])
        else { return nil }
        return Data(SHA256.hash(data: json))
    }
}
