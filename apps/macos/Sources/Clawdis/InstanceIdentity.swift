import Foundation

enum InstanceIdentity {
    private static let suiteName = "com.steipete.clawdis.shared"
    private static let instanceIdKey = "instanceId"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    static let instanceId: String = {
        let defaults = Self.defaults
        if let existing = defaults.string(forKey: instanceIdKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            return existing
        }

        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: instanceIdKey)
        return id
    }()

    static let displayName: String = {
        if let name = Host.current().localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty
        {
            return name
        }
        return "clawdis-mac"
    }()
}
