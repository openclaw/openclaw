import Foundation

public enum OpenClawChatMediaURL {
    /// Exact-resource grants are separate from managed outgoing-media tickets.
    /// Never resolve arbitrary artifact URLs with Gateway credentials.
    public static func resolveArtifactDownload(gatewayURL: URL, ticketedPath: String) -> URL? {
        let prefix = "/api/artifacts/download/"
        guard ticketedPath.hasPrefix(prefix),
              let relative = URLComponents(string: ticketedPath),
              relative.scheme == nil, relative.host == nil,
              relative.query == nil, relative.fragment == nil,
              relative.percentEncodedPath == ticketedPath
        else { return nil }
        let components = ticketedPath.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        let safeCharacters =
            CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        guard components.count == 2,
              components.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(safeCharacters.contains) }),
              var base = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false),
              base.host != nil
        else { return nil }
        switch base.scheme?.lowercased() {
        case "wss", "https": base.scheme = "https"
        case "ws", "http": base.scheme = "http"
        default: return nil
        }
        let contextPath = base.percentEncodedPath == "/" ? "" : base.percentEncodedPath
        base.percentEncodedPath = contextPath + relative.percentEncodedPath
        base.percentEncodedQuery = nil
        base.fragment = nil
        return base.url
    }

    public static func resolve(
        gatewayURL: URL,
        ticketedPath: String,
        playback: OpenClawChatPlaybackMode?) -> URL?
    {
        let prefix = "/api/chat/media/outgoing/"
        guard ticketedPath.hasPrefix(prefix),
              let relative = URLComponents(string: ticketedPath),
              relative.scheme == nil,
              relative.host == nil,
              relative.fragment == nil,
              relative.percentEncodedPath.hasPrefix(prefix),
              relative.queryItems?.contains(where: {
                  $0.name == "mediaTicket" && $0.value?.isEmpty == false
              }) == true,
              var base = URLComponents(url: gatewayURL, resolvingAgainstBaseURL: false),
              base.host != nil
        else { return nil }
        switch base.scheme?.lowercased() {
        case "wss", "https": base.scheme = "https"
        case "ws", "http": base.scheme = "http"
        default: return nil
        }
        // The Gateway returns a root-relative route, but the proxy owns its prefix.
        // Preserve encoded octets and repeated slashes just as the WebSocket does.
        let contextPath = base.percentEncodedPath == "/" ? "" : base.percentEncodedPath
        base.percentEncodedPath = contextPath + relative.percentEncodedPath
        base.percentEncodedQuery = relative.percentEncodedQuery
        base.fragment = nil
        if playback == .transcode {
            var queryItems = base.queryItems ?? []
            queryItems.removeAll { $0.name == "playback" }
            queryItems.append(URLQueryItem(name: "playback", value: "1"))
            base.queryItems = queryItems
        }
        return base.url
    }
}
