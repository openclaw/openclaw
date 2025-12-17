import Foundation

public enum ClawdisBonjour {
    // v0: internal-only, subject to rename.
    public static let bridgeServiceType = "_clawdis-bridge._tcp"
    public static let bridgeServiceDomain = "local."
    public static let wideAreaBridgeServiceDomain = "clawdis.internal."

    public static let bridgeServiceDomains = [
        bridgeServiceDomain,
        wideAreaBridgeServiceDomain,
    ]

    public static func normalizeServiceDomain(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return self.bridgeServiceDomain
        }

        let lower = trimmed.lowercased()
        if lower == "local" || lower == "local." {
            return self.bridgeServiceDomain
        }

        return lower.hasSuffix(".") ? lower : (lower + ".")
    }
}
