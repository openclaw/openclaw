import Foundation

public enum LocalNetworkURLSupport {
    public static func isLocalNetworkHTTPURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return false
        }
        return LoopbackHost.isLocalNetworkHost(host)
    }
}
