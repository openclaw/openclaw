import Foundation

public enum ClawdbotBonjour {
    // v0: internal-only, subject to rename.
    public static let bridgeServiceType = "_clawdbot-bridge._tcp"
    public static let bridgeServiceDomain = "local."
    public static let wideAreaBridgeServiceDomain = "clawdbot.internal."

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
