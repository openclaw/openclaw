import Foundation

enum HostEnvSanitizer {
    private static let blockedKeys: Set<String> = [
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYLIB",
        "RUBYOPT",
        "BASH_ENV",
        "ENV",
        "GCONV_PATH",
        "IFS",
        "SSLKEYLOGFILE",
    ]

    private static let blockedPrefixes: [String] = [
        "DYLD_",
        "LD_",
        "BASH_FUNC_",
    ]

    private static func isBlocked(_ upperKey: String) -> Bool {
        if self.blockedKeys.contains(upperKey) { return true }
        return self.blockedPrefixes.contains(where: { upperKey.hasPrefix($0) })
    }

    static func sanitize(overrides: [String: String]?) -> [String: String] {
        var merged: [String: String] = [:]
        for (rawKey, value) in ProcessInfo.processInfo.environment {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            if self.isBlocked(upper) { continue }
            merged[key] = value
        }

        guard let overrides else { return merged }
        for (rawKey, value) in overrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            // PATH is part of the security boundary (command resolution + safe-bin checks). Never
            // allow request-scoped PATH overrides from agents/gateways.
            if upper == "PATH" { continue }
            if self.isBlocked(upper) { continue }
            merged[key] = value
        }
        return merged
    }
}
