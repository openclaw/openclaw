import Foundation

public struct SharedContentPayload: Sendable, Equatable {
    public let title: String?
    public let url: URL?
    public let text: String?

    public init(title: String?, url: URL?, text: String?) {
        self.title = title
        self.url = url
        self.text = text
    }
}

public enum ShareToAgentDeepLink {
    public static func buildURL(from payload: SharedContentPayload, instruction: String? = nil) -> URL? {
        let message = self.buildMessage(from: payload, instruction: instruction)
        guard !message.isEmpty else { return nil }

        var components = URLComponents()
        components.scheme = "openclaw"
        components.host = "agent"
        components.queryItems = [
            URLQueryItem(name: "message", value: message),
            URLQueryItem(name: "thinking", value: "low"),
        ]
        return components.url
    }

    public static func buildMessage(from payload: SharedContentPayload, instruction: String? = nil) -> String {
        let title = self.clean(payload.title)
        let text = self.clean(payload.text)
        let urlText = self.clean(payload.url?.absoluteString)
        let resolvedInstruction = self.clean(instruction)
        let hasSharedContent = title != nil || text != nil || urlText != nil

        guard hasSharedContent || resolvedInstruction != nil else { return "" }

        var lines: [String] = []
        if hasSharedContent {
            lines.append("Shared from iOS.")
        }
        if let title {
            lines.append("Title: \(title)")
        }
        if let urlText {
            lines.append("URL: \(urlText)")
        }
        if let text {
            lines.append("Text:\n\(text)")
        }
        if let resolvedInstruction {
            lines.append(resolvedInstruction)
        }

        let message = lines.joined(separator: "\n\n")
        return String(message.prefix(2400))
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
