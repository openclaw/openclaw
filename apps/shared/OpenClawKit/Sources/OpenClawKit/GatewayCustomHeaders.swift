import Foundation
import OpenClawMobileCore

/// Operator-defined HTTP headers attached to every gateway-bound request so gateways fronted
/// by authenticating reverse proxies (Cloudflare Access-style service tokens) stay reachable.
/// Header values are credentials: persist them in the platform secure store and never log them.
public enum GatewayCustomHeaders {
    public static func isReservedName(_ name: String) -> Bool {
        MobileCoreBridge.shared.isReservedGatewayHeaderName(name: name)
    }

    /// Drops entries that cannot travel as a single well-formed header: empty, reserved, or
    /// non-token names, and values with control characters (request-splitting guard).
    public static func sanitized(_ headers: [String: String]) -> [String: String] {
        guard JSONSerialization.isValidJSONObject(headers),
              let input = try? JSONSerialization.data(withJSONObject: headers),
              let inputJSON = String(data: input, encoding: .utf8),
              let output = MobileCoreBridge.shared.sanitizeGatewayHeadersForApple(headersJson: inputJSON).data(using: .utf8),
              let sanitized = try? JSONSerialization.jsonObject(with: output) as? [String: String]
        else {
            return [:]
        }
        return sanitized
    }
}
