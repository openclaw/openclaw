import OpenClawProtocol

public struct GatewayAttachmentLimits: Sendable, Equatable {
    public let maxBytes: Int
    public let maxImageBytes: Int

    public init(maxBytes: Int, maxImageBytes: Int) {
        self.maxBytes = maxBytes
        self.maxImageBytes = maxImageBytes
    }
}

extension HelloOk {
    /// Decoded file-size ceilings belong to this hello; absent policy carries
    /// no client-side limit, matching the web composer's admission contract.
    public func advertisedAttachmentLimits() -> GatewayAttachmentLimits? {
        guard let attachments = self.policy["attachments"]?.dictionaryValue,
              let maxBytes = attachments["maxBytes"]?.intValue,
              let maxImageBytes = attachments["maxImageBytes"]?.intValue
        else { return nil }
        return GatewayAttachmentLimits(maxBytes: maxBytes, maxImageBytes: maxImageBytes)
    }
}
