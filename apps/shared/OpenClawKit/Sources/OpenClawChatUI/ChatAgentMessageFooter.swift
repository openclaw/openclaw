#if os(iOS)
import SwiftUI

/// Under an agent reply: its reactions pill, when it has reactions, and its time. The reply's
/// actions live in its long-press menu. No agent name: the line belongs to the reply above it.
@MainActor
struct ChatAgentMessageFooter: View {
    let viewModel: OpenClawChatViewModel
    /// The row's message, which owns the reactions.
    let message: OpenClawChatMessage
    let timestamp: Double?
    let openPicker: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if !self.viewModel.messageReactions(for: self.message).isEmpty {
                ChatReactionPill(viewModel: self.viewModel, message: self.message, openPicker: self.openPicker)
                    // The canvas ring is invisible here; line the pill's fill up with the text.
                        .padding(.leading, -ChatReactionPillLabel.ring)
            }
            ChatMessageRelativeTimestamp(timestamp: self.timestamp)
                .fixedSize()
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-agent-message-footer")
    }
}

extension View {
    /// A held agent reply opens the message menu over its opening lines; a reply with no text
    /// lifts as it is. VoiceOver offers the same items as the reply's actions.
    @ViewBuilder
    func chatAgentReplyMenu(previewText: String, @ViewBuilder items: () -> some View) -> some View {
        if previewText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.chatActionContextMenu(items: items)
                .accessibilityActions(items)
        } else {
            self.chatActionContextMenu(items: items) {
                ChatReplyMenuPreview(text: previewText)
            }
            .accessibilityActions(items)
        }
    }
}

/// What a held agent reply lifts above its menu: the reply's opening lines at reading size, never
/// a shrunken picture of the whole message.
struct ChatReplyMenuPreview: View {
    /// The preview's width and height bound. The width matches the transcript's reading column on
    /// a phone; the height keeps the menu on screen for any reply length.
    static let width: CGFloat = 370
    static let maximumLines = 8

    let text: String

    var body: some View {
        Text(Self.attributed(self.text))
            .font(OpenClawChatTypography.body)
            .foregroundStyle(OpenClawChatTheme.assistantText)
            .lineLimit(Self.maximumLines)
            .multilineTextAlignment(.leading)
            .frame(width: Self.width - 32, alignment: .leading)
            .padding(16)
            // The reply's own surface, so the excerpt reads as the reply it came from.
            .background(Color(uiColor: OpenClawChatTheme.canvasUIColor))
    }

    /// The reply's prose without its fenced blocks (code, diagrams) and heading marks; a reply that
    /// is only a fenced block keeps it.
    static func prose(_ text: String) -> String {
        var lines: [Substring] = []
        var inFence = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop { $0 == " " }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            guard !inFence else { continue }
            lines.append(trimmed.hasPrefix("#") ? trimmed.drop { $0 == "#" }.drop { $0 == " " } : line)
        }
        let prose = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return prose.isEmpty ? text : prose
    }

    /// Inline Markdown only (bold, italic, code spans, links), so the excerpt reads like the reply
    /// without laying out its blocks.
    private static func attributed(_ text: String) -> AttributedString {
        let excerpt = ChatReplyQuote.targetText(self.prose(text))
        return (try? AttributedString(
            markdown: excerpt,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(excerpt)
    }
}
#endif
