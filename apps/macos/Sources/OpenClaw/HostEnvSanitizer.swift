import Foundation

enum HostEnvSanitizer {
    /// Generated from src/infra/host-env-security-policy.json via scripts/generate-host-env-security-policy-swift.mjs.
    /// Parity is validated by src/infra/host-env-security.policy-parity.test.ts.
    private static let blockedKeys = HostEnvSecurityPolicy.blockedKeys
    private static let blockedPrefixes = HostEnvSecurityPolicy.blockedPrefixes
    private static let blockedOverrideKeys = HostEnvSecurityPolicy.blockedOverrideKeys
    private static let shellWrapperAllowedOverrideKeys: Set<String> = [
        "TERM",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LC_MESSAGES",
        "COLORTERM",
        "NO_COLOR",
        "FORCE_COLOR",
    ]

    private static func isBlocked(_ upperKey: String) -> Bool {
        if self.blockedKeys.contains(upperKey) { return true }
        return self.blockedPrefixes.contains(where: { upperKey.hasPrefix($0) })
    }

    private static func filterOverridesForShellWrapper(_ overrides: [String: String]?) -> [String: String]? {
        guard let overrides else { return nil }
        var filtered: [String: String] = [:]
        for (rawKey, value) in overrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            if self.shellWrapperAllowedOverrideKeys.contains(key.uppercased()) {
                filtered[key] = value
            }
        }
        return filtered.isEmpty ? nil : filtered
    }

    static func sanitize(overrides: [String: String]?, shellWrapper: Bool = false) -> [String: String] {
        var merged: [String: String] = [:]
        for (rawKey, value) in ProcessInfo.processInfo.environment {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            if self.isBlocked(upper) { continue }
            merged[key] = value
        }

        let effectiveOverrides = shellWrapper
            ? self.filterOverridesForShellWrapper(overrides)
            : overrides

        guard let effectiveOverrides else { return merged }
        for (rawKey, value) in effectiveOverrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            // PATH is part of the security boundary (command resolution + safe-bin checks). Never
            // allow request-scoped PATH overrides from agents/gateways.
            if upper == "PATH" { continue }
            if self.blockedOverrideKeys.contains(upper) { continue }
            if self.isBlocked(upper) { continue }
            merged[key] = value
        }
        return merged
    }
}
