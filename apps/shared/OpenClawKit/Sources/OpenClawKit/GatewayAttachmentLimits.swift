import OpenClawProtocol

public struct GatewayAttachmentLimits: Sendable, Equatable {
    /// Older Gateways do not advertise attachment limits, so native uploads retain their client ceilings.
    public static let legacyClientFallback = Self(maxBytes: 20 * 1024 * 1024, maxImageBytes: 5_000_000)
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
        let ceiling: Int
        if let maxPayload = self.policy["maxPayload"]?.intValue {
            // Match chat-attachment-policy.ts: reserve the envelope, then account
            // for base64 expansion. Divide first so a malformed Int.max cannot overflow.
            let available = max(0, max(0, maxPayload) - 256 * 1024)
            ceiling = (available / 4) * 3 + (available % 4) * 3 / 4
        } else {
            ceiling = Int(Int32.max)
        }
        return GatewayAttachmentLimits(maxBytes: min(maxBytes, ceiling), maxImageBytes: min(maxImageBytes, ceiling))
    }
}
