import Foundation

/// Helpers for traversing an identity-aware reverse proxy that fronts the gateway.
///
/// A gateway is commonly published behind a proxy (Caddy, nginx, …) that enforces
/// HTTP Basic auth at the edge. The gateway's own auth (device token / shared token /
/// password) travels inside the `connect` protocol message, so a proxy `Authorization`
/// header never collides with it. These headers are applied to the WebSocket upgrade
/// request via `WebSocketSessioning.makeWebSocketTask(url:headers:)`.
public enum GatewayProxyAuth {
    /// HTTP header name carrying the reverse-proxy credentials.
    public static let authorizationHeader = "Authorization"

    /// Returns `["Authorization": "Basic …"]` for the supplied credentials, or an empty
    /// dictionary when no username is configured. An empty password is allowed
    /// (RFC 7617 permits `user:` with an empty secret).
    public static func basicAuthHeaders(username: String?, password: String?) -> [String: String] {
        let user = (username ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !user.isEmpty else { return [:] }
        let secret = password ?? ""
        let encoded = Data("\(user):\(secret)".utf8).base64EncodedString()
        return [self.authorizationHeader: "Basic \(encoded)"]
    }
}
