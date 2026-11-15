import Foundation

public enum GatewayUserPreferences {
    public enum ProfileAccent: Equatable, Sendable {
        case inherited
        case theme
        case color(String)
    }

    /// An ok read with an absent key is authoritative empty; unavailable identity is not.
    public static func decodeRailShortcuts(_ data: Data) throws -> [String]? {
        let response = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard response?["status"] as? String == "ok",
              let entries = response?["entries"] as? [String: Any]
        else { return nil }
        guard let value = entries["ui.railShortcuts"] else { return [] }
        guard let values = value as? [Any] else { return nil }
        return values.compactMap { $0 as? String }
    }

    /// Match web personalSessionPinKeys: rail shortcuts are not Sessions pins.
    public static func personalSessionPinKeys(_ entries: [String]) -> Set<String> {
        Set(entries.compactMap { entry in
            guard entry.hasPrefix("session:") else { return nil }
            let key = String(entry.dropFirst("session:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
            return key.isEmpty ? nil : key
        })
    }

    /// Rebase one pin intent on a fresh server read, retaining other clients' shortcuts.
    public static func settingPersonalPin(_ pinned: Bool, key: String, in entries: [String]) -> [String] {
        guard let key = key.trimmedNonEmpty else { return entries }
        if pinned, self.personalSessionPinKeys(entries).contains(key) {
            return entries
        }
        let remaining = entries.filter { self.personalSessionPinKeys([$0]) != [key] }
        return pinned ? remaining + ["session:\(key)"] : remaining
    }

    /// Compare-and-set the exact freshly observed value, including absence as JSON null.
    public static func personalPinWriteParams(_ data: Data, pinned: Bool, key: String) throws -> String? {
        guard let key = key.trimmedNonEmpty else { return nil }
        guard let entries = try decodeRailShortcuts(data) else { return nil }
        let response = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let rawEntries = response?["entries"] as? [String: Any]
        let params = try JSONSerialization.data(withJSONObject: [
            "entries": ["ui.railShortcuts": self.settingPersonalPin(pinned, key: key, in: entries)],
            "expectedEntries": ["ui.railShortcuts": rawEntries?["ui.railShortcuts"] ?? NSNull()],
        ])
        return String(bytes: params, encoding: .utf8)
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
