import Foundation

/// A user's upload as history records it, `media://inbound/<id>`. The Control UI reads these
/// through the Gateway's assistant-media route as thumbnails
/// (ui/src/pages/chat/components/chat-message-local-media.ts:23-55,
/// ui/src/app/assistant-media.ts:10-35); the iOS transport reads the same route.
public enum OpenClawChatInboundMedia {
    private static let prefix = "media://inbound/"
    /// The web's default preview rendition (src/shared/chat-image-renditions.ts:5).
    static let thumbnailWidth = 960
    /// A 960-wide rendition stays under 256 KB (chat-image-renditions.ts:7-10); allow headroom.
    public static let maximumThumbnailBytes = 1024 * 1024
    /// The Gateway's own frame cap (src/gateway/payload-limits.ts:4); no upload is larger.
    public static let maximumOriginalBytes = 25 * 1024 * 1024

    /// The one-segment canonical form the web fetches; anything else is not a fetchable upload.
    public static func canonicalSource(_ raw: String?) -> String? {
        guard let source = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              source.lowercased().hasPrefix(self.prefix)
        else { return nil }
        let id = source.dropFirst(self.prefix.count)
        guard !id.isEmpty, !id.contains(where: { "/?#".contains($0) }),
              let decoded = String(id).removingPercentEncoding,
              decoded != ".", decoded != "..",
              !decoded.contains("/"), !decoded.contains("\\"), !decoded.contains("\0")
        else { return nil }
        return source
    }

    /// `<origin><base>/__openclaw__/assistant-media?source=…&variant=thumbnail&width=960&v=4`, the
    /// URL the web builds for an inbound image (chat-message-local-media.ts:39-55).
    public static func thumbnailURL(
        source: String,
        context: OpenClawChatSourceContext,
        sessionKey: String,
        agentID: String?) -> URL?
    {
        self.url(source: source, context: context, sessionKey: sessionKey, agentID: agentID, thumbnail: true)
    }

    /// The same URL without the rendition: the bytes as uploaded, which the web's full-size view
    /// reads (chat-message-local-media.ts:39-55 with no `variant`).
    public static func originalURL(
        source: String,
        context: OpenClawChatSourceContext,
        sessionKey: String,
        agentID: String?) -> URL?
    {
        self.url(source: source, context: context, sessionKey: sessionKey, agentID: agentID, thumbnail: false)
    }

    private static func url(
        source: String,
        context: OpenClawChatSourceContext,
        sessionKey: String,
        agentID: String?,
        thumbnail: Bool) -> URL?
    {
        guard let source = self.canonicalSource(source),
              var url = URLComponents(url: context.gatewayURL, resolvingAgainstBaseURL: false)
        else { return nil }
        var query = [("source", source), ("sessionKey", sessionKey)]
        if let agentID { query.append(("agentId", agentID)) }
        if thumbnail {
            query += [("variant", "thumbnail"), ("width", String(self.thumbnailWidth)), ("v", "4")]
        }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        url.percentEncodedPath = context.basePath + "/__openclaw__/assistant-media"
        url.percentEncodedQuery = query.map { name, value in
            "\(name)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")"
        }.joined(separator: "&")
        url.fragment = nil
        return url.url
    }
}
