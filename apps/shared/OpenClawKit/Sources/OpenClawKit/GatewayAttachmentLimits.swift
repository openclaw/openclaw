import OpenClawProtocol

public struct GatewayAttachmentLimits: Sendable, Equatable {
    /// Older Gateways do not advertise attachment limits, so native uploads retain their client ceilings.
    public static let legacyClientFallback = Self(maxBytes: 20 * 1024 * 1024, maxImageBytes: 5_000_000)
    /// Valid Gateways advertise at most one WebSocket frame; this bound keeps a malformed hello from overflowing reads.
    static let maximumAdvertisedBytes = Int(Int32.max)

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
        let ceiling = GatewayAttachmentLimits.maximumAdvertisedBytes
        return GatewayAttachmentLimits(maxBytes: min(maxBytes, ceiling), maxImageBytes: min(maxImageBytes, ceiling))
    }
}
