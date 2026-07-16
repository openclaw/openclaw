import Foundation

func canonicalizeCanvasHostUrl(raw: String?, activeURL: URL?) -> String? {
    let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else { return nil }
    guard var parsed = URLComponents(string: trimmed) else { return trimmed }

    let parsedHost = parsed.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let parsedIsLoopback = !parsedHost.isEmpty && LoopbackHost.isLoopback(parsedHost)

    if !parsedHost.isEmpty, !parsedIsLoopback {
        guard let activeURL else { return trimmed }
        let isTLS = activeURL.scheme?.lowercased() == "wss"
        guard isTLS else { return trimmed }
        parsed.scheme = "https"
        if parsed.port == nil {
            let tlsPort = activeURL.port ?? 443
            parsed.port = (tlsPort == 443) ? nil : tlsPort
        }
        return parsed.string ?? trimmed
    }

    guard let activeURL, let fallbackHost = activeURL.host, !LoopbackHost.isLoopback(fallbackHost) else {
        return trimmed
    }
    let isTLS = activeURL.scheme?.lowercased() == "wss"
    parsed.scheme = isTLS ? "https" : "http"
    parsed.host = fallbackHost
    let fallbackPort = activeURL.port ?? (isTLS ? 443 : 80)
    parsed.port = ((isTLS && fallbackPort == 443) || (!isTLS && fallbackPort == 80)) ? nil : fallbackPort
    return parsed.string ?? trimmed
}
