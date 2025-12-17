import Darwin
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

    static let modelIdentifier: String? = {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 1 else { return nil }

        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buffer, &size, nil, 0) == 0 else { return nil }

        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        let s = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }()
}
