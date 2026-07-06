import Foundation

/// Plain-text projection of a transcript message: exactly what the reader sees
/// in the bubble, with tool traces and non-text blocks removed. Shared by the
/// transcript exporter and the Listen action so exported and spoken text
/// always match the visible transcript.
enum ChatMessageVisibleText {
    static func visibleText(in message: OpenClawChatMessage) -> String {
        let text = self.primaryText(in: message)
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard role != "user" else { return text }
        return AssistantTextParser.visibleSegments(from: text)
            .map(\.text)
            .joined(separator: "\n\n")
    }

    /// Cheap per-row gate for text-derived actions; avoids running the segment
    /// parser on every bubble render.
    static func hasTextContent(in message: OpenClawChatMessage) -> Bool {
        message.content.contains { content in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return false }
            let text = content.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return !text.isEmpty
        }
    }

    private static func primaryText(in message: OpenClawChatMessage) -> String {
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return nil }
            return content.text
        }
        return OpenClawChatMessage.displayText(
            contentText: parts.joined(separator: "\n"),
            role: message.role,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage)
    }
}
