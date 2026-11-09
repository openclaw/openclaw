import Foundation
import OpenClawKit

/// A sandbox may reuse the Gateway certificate only when the authenticated board
/// advertises that exact, separate listener. It never receives Gateway credentials.
struct DashboardWidgetSandboxSnapshot: Decodable {
    struct Widget: Decodable {
        let sandboxPort: Int?
        let sandboxOrigin: String?
    }

    let sessionKey: String
    let widgets: [Widget]

    func pinnedParameters(
        sessionKey: String,
        agentID: String? = nil,
        gatewayURL: URL,
        fingerprint: String?,
        host: String,
        port: Int) -> GatewayTLSParams?
    {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let expectedKey = key.lowercased() == "global" && !owner.isEmpty ? "agent:\(owner):global" : key
        guard self.sessionKey == expectedKey,
              gatewayURL.scheme == "https",
              let gateway = GatewayTLSAuthority(url: gatewayURL),
              let fingerprint, fingerprint.count == 64,
              fingerprint.allSatisfy(\.isHexDigit),
              (1...65535).contains(port), port != gateway.port,
              var sandboxURL = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false)
        else { return nil }
        sandboxURL.port = port
        guard let url = sandboxURL.url,
              GatewayTLSAuthority(url: url)?.matches(host: host, port: port) == true,
              self.widgets.contains(where: { $0.sandboxOrigin == nil && $0.sandboxPort == port })
        else { return nil }
        // No first-use trust, Keychain write, cross-host pin, or certificate fallback.
        return GatewayTLSParams(required: true, expectedFingerprint: fingerprint, allowTOFU: false, storeKey: nil)
    }
}

@MainActor
struct DashboardWidgetTLSAdmission {
    let parameters: GatewayTLSParams
    let isCurrent: @MainActor () -> Bool
}

typealias DashboardWidgetTLSProvider = @MainActor (String, Int) async -> DashboardWidgetTLSAdmission?
