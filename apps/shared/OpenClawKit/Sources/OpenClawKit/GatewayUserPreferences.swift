import Foundation

public enum GatewayUserPreferences {
    public enum ProfileAccent: Equatable, Sendable {
        case inherited
        case theme
        case color(String)
    }

    /// Strict #rrggbb validation (leading "#" optional); canonical lowercase "#rrggbb".
    public static func normalizedAccentHex(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmedNonEmpty else { return nil }
        let hex = (trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed).lowercased()
        guard hex.count == 6, hex.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return "#\(hex)"
    }

    /// A saved "theme" preference suppresses the operator color even though it has no hex value.
    public static func gatewayAccentHex(preference: String?, seamColor: String?) -> String? {
        if preference == "theme" { return nil }
        return self.normalizedAccentHex(preference) ?? self.normalizedAccentHex(seamColor)
    }

    /// An explicit theme choice must remain distinct from an absent profile preference.
    public static func decodeProfileAccent(_ data: Data) throws -> ProfileAccent {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["status"] as? String == "ok"
        else { return .inherited }
        let entries = json["entries"] as? [String: Any]
        let raw = entries?["ui.accent"] as? String
        if raw == "theme" { return .theme }
        guard let hex = self.normalizedAccentHex(raw) else { return .inherited }
        return .color(hex)
    }

    /// iOS still consumes only hex accents; preserve its established projection.
    public static func decodeProfileAccentHex(_ data: Data) throws -> String? {
        switch try self.decodeProfileAccent(data) {
        case let .color(hex): hex
        case .inherited, .theme: nil
        }
    }
}
