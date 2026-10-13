import OpenClawProtocol

public struct GatewayAttachmentLimits: Sendable, Equatable {
    /// Older Gateways use the default frame budget and the existing processed-image ceiling.
    public static let legacyClientFallback = Self(maxBytes: frameSafeMaxBytes(), maxImageBytes: 5_000_000)
    private static let defaultMaxPayloadBytes = 25 * 1024 * 1024

    fileprivate static func frameSafeMaxBytes(maxPayload: Int? = nil) -> Int {
        // Match chat-attachment-policy.ts: reserve the envelope, then account
        // for base64 expansion. Divide first so a malformed Int.max cannot overflow.
        let payload = maxPayload ?? Self.defaultMaxPayloadBytes
        let available = max(0, max(0, payload) - 256 * 1024)
        return (available / 4) * 3 + (available % 4) * 3 / 4
    }

    public let maxBytes: Int
    public let maxImageBytes: Int

    public init(maxBytes: Int, maxImageBytes: Int) {
        self.maxBytes = maxBytes
        self.maxImageBytes = maxImageBytes
    }
}

extension HelloOk {
    /// Returns advertised ceilings; native staging supplies its legacy fallback when absent.
    public func advertisedAttachmentLimits() -> GatewayAttachmentLimits? {
        guard let attachments = self.policy["attachments"]?.dictionaryValue,
              let maxBytes = attachments["maxBytes"]?.intValue,
              let maxImageBytes = attachments["maxImageBytes"]?.intValue,
              maxBytes > 0, maxImageBytes > 0
        else { return nil }
        let ceiling = GatewayAttachmentLimits.frameSafeMaxBytes(maxPayload: self.policy["maxPayload"]?.intValue)
        return GatewayAttachmentLimits(maxBytes: min(maxBytes, ceiling), maxImageBytes: min(maxImageBytes, ceiling))
    }
}
