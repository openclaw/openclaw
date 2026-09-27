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
              let maxImageBytes = attachments["maxImageBytes"]?.intValue
        else { return nil }
        return GatewayAttachmentLimits(maxBytes: maxBytes, maxImageBytes: maxImageBytes)
    }
}
