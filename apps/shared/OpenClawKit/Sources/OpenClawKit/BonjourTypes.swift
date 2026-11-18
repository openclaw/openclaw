import Foundation

public enum OpenClawBonjour {
    // v0: internal-only, subject to rename.
    public static let gatewayServiceType = "_openclaw-gw._tcp"
    public static let gatewayServiceDomain = "local."
    public static var wideAreaGatewayServiceDomain: String? {
        let normalized = self.normalizeServiceDomain(ProcessInfo.processInfo.environment["OPENCLAW_WIDE_AREA_DOMAIN"])
        return normalized == self.gatewayServiceDomain ? nil : normalized
    }

    public static var gatewayServiceDomains: [String] {
        var domains = [gatewayServiceDomain]
        if let wideArea = wideAreaGatewayServiceDomain {
            domains.append(wideArea)
        }
        return domains
    }

    public static func normalizeServiceDomain(_ raw: String?) -> String {
        guard let trimmed = raw?.trimmedNonEmpty else { return self.gatewayServiceDomain }

        let lower = trimmed.lowercased()
        return lower.hasSuffix(".") ? lower : (lower + ".")
    }
}
