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
        let title = payload.title?.trimmedNonEmpty
        let text = payload.text?.trimmedNonEmpty
        let urlText = payload.url?.absoluteString.trimmedNonEmpty
        let resolvedInstruction = instruction?.trimmedNonEmpty
        let hasSharedContent = title != nil || text != nil || urlText != nil

        var lines: [String] = []
        if hasSharedContent {
            lines.append("Shared from iOS.")
        }
        lines.append(contentsOf: [
            title.map { "Title: \($0)" },
            urlText.map { "URL: \($0)" },
            text.map { "Text:\n\($0)" },
            resolvedInstruction,
        ].compactMap(\.self))

        let message = lines.joined(separator: "\n\n")
        return String(message.prefix(2400))
    }
}
