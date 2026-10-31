import Foundation

/// A Cloudflare Access credential typed into the header-name field.
enum GatewayCustomHeaderCredential: Equatable {
    case clientId
    case secret
}

enum GatewayCustomHeaderNames {
    private static let clientId = try? NSRegularExpression(
        pattern: "^[0-9a-f]{32}\\.access$",
        options: [.caseInsensitive])
    private static let legacySecret = try? NSRegularExpression(pattern: "^[0-9a-f]{64}$", options: [.caseInsensitive])
    private static let copiedPunctuation = CharacterSet(charactersIn: "\"'`.")

    /// Quotes, backticks, and a trailing period are legal in a header token, so strip copies of them.
    static func credential(named name: String) -> GatewayCustomHeaderCredential? {
        let trimmed = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: self.copiedPunctuation)
        if Self.matches(Self.clientId, trimmed) {
            return .clientId
        }
        if Self.matches(Self.legacySecret, trimmed) || trimmed.lowercased().hasPrefix("cfast_") {
            return .secret
        }
        return nil
    }

    private static func matches(_ expression: NSRegularExpression?, _ value: String) -> Bool {
        guard let expression else { return false }
        let range = NSRange(value.startIndex..., in: value)
        return expression.firstMatch(in: value, range: range)?.range == range
    }

    static func displayName(for name: String) -> String {
        switch self.credential(named: name) {
        case .clientId:
            String(localized: "Client ID saved as a header name")
        case .secret:
            String(localized: "Secret saved as a header name")
        case nil:
            name
        }
    }
}
