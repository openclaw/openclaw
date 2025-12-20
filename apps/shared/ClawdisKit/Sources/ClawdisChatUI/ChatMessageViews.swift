import Foundation
import SwiftUI

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 560
    static let bubbleCorner: CGFloat = 18
}

@MainActor
struct ChatMessageBubble: View {
    let message: ClawdisChatMessage
    let style: ClawdisChatView.Style

    var body: some View {
        ChatMessageBody(message: self.message, isUser: self.isUser, style: self.style)
            .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: self.isUser ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: self.isUser ? .trailing : .leading)
            .padding(.horizontal, 2)
    }

    private var isUser: Bool { self.message.role.lowercased() == "user" }
}

@MainActor
private struct ChatMessageBody: View {
    let message: ClawdisChatMessage
    let isUser: Bool
    let style: ClawdisChatView.Style

    var body: some View {
        let text = self.primaryText
        let split = ChatMarkdownSplitter.split(markdown: text)
        let textColor = self.isUser ? ClawdisChatTheme.userText : ClawdisChatTheme.assistantText

        VStack(alignment: .leading, spacing: 10) {
            ForEach(split.blocks) { block in
                switch block.kind {
                case .text:
                    MarkdownTextView(text: block.text, textColor: textColor)
                case let .code(language):
                    CodeBlockView(code: block.text, language: language, isUser: self.isUser)
                }
            }

            if !split.images.isEmpty {
                ForEach(
                    split.images,
                    id: \ChatMarkdownSplitter.InlineImage.id)
                { (item: ChatMarkdownSplitter.InlineImage) in
                    if let img = item.image {
                        ClawdisPlatformImageFactory.image(img)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                    } else {
                        Text(item.label.isEmpty ? "Image" : item.label)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if !self.inlineAttachments.isEmpty {
                ForEach(self.inlineAttachments.indices, id: \.self) { idx in
                    AttachmentRow(att: self.inlineAttachments[idx], isUser: self.isUser)
                }
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .foregroundStyle(textColor)
        .background(self.bubbleBackground)
        .overlay(self.bubbleBorder)
        .clipShape(RoundedRectangle(cornerRadius: ChatUIConstants.bubbleCorner, style: .continuous))
    }

    private var primaryText: String {
        let parts = self.message.content.compactMap(\.text)
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var inlineAttachments: [ClawdisChatMessageContent] {
        self.message.content.filter { ($0.type ?? "text") != "text" }
    }

    private var bubbleBackground: AnyShapeStyle {
        let fill: Color
        if self.isUser {
            fill = ClawdisChatTheme.userBubble
        } else if self.style == .onboarding {
            fill = ClawdisChatTheme.card
        } else {
            fill = ClawdisChatTheme.assistantBubble
        }
        return AnyShapeStyle(fill)
    }

    private var bubbleBorder: some View {
        RoundedRectangle(cornerRadius: ChatUIConstants.bubbleCorner, style: .continuous)
            .strokeBorder(
                self.isUser ? Color.white.opacity(0.12) : Color.black.opacity(0.08),
                lineWidth: self.isUser ? 0.5 : 1)
    }
}

private struct AttachmentRow: View {
    let att: ClawdisChatMessageContent
    let isUser: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip")
            Text(self.att.fileName ?? "Attachment")
                .font(.footnote)
                .lineLimit(1)
                .foregroundStyle(self.isUser ? ClawdisChatTheme.userText : ClawdisChatTheme.assistantText)
            Spacer()
        }
        .padding(10)
        .background(self.isUser ? Color.white.opacity(0.2) : Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    let style: ClawdisChatView.Style

    var body: some View {
        HStack(spacing: 10) {
            TypingDots()
            if self.style == .standard {
                Text("Clawd is thinking…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .padding(.vertical, self.style == .standard ? 12 : 10)
        .padding(.horizontal, self.style == .standard ? 12 : 14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ClawdisChatTheme.assistantBubble))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ChatMarkdownBody(text: self.text, textColor: ClawdisChatTheme.assistantText)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ClawdisChatTheme.assistantBubble))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
    }
}

@MainActor
struct ChatPendingToolsBubble: View {
    let toolCalls: [ClawdisChatPendingToolCall]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Running tools…", systemImage: "hammer")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(self.toolCalls) { call in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(call.name)
                        .font(.footnote.monospaced())
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    ProgressView().controlSize(.mini)
                }
                .padding(10)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ClawdisChatTheme.assistantBubble))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
    }
}

@MainActor
private struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var animate = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { idx in
                Circle()
                    .fill(Color.secondary.opacity(0.55))
                    .frame(width: 7, height: 7)
                    .scaleEffect(self.reduceMotion ? 0.85 : (self.animate ? 1.05 : 0.70))
                    .opacity(self.reduceMotion ? 0.55 : (self.animate ? 0.95 : 0.30))
                    .animation(
                        self.reduceMotion ? nil : .easeInOut(duration: 0.55)
                            .repeatForever(autoreverses: true)
                            .delay(Double(idx) * 0.16),
                        value: self.animate)
            }
        }
        .onAppear {
            guard !self.reduceMotion else { return }
            self.animate = true
        }
    }
}

@MainActor
private struct MarkdownTextView: View {
    let text: String
    let textColor: Color

    var body: some View {
        if let attributed = try? AttributedString(markdown: self.text) {
            Text(attributed)
                .font(.system(size: 14))
                .foregroundStyle(self.textColor)
        } else {
            Text(self.text)
                .font(.system(size: 14))
                .foregroundStyle(self.textColor)
        }
    }
}

@MainActor
private struct ChatMarkdownBody: View {
    let text: String
    let textColor: Color

    var body: some View {
        let split = ChatMarkdownSplitter.split(markdown: self.text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(split.blocks) { block in
                switch block.kind {
                case .text:
                    MarkdownTextView(text: block.text, textColor: self.textColor)
                case let .code(language):
                    CodeBlockView(code: block.text, language: language, isUser: false)
                }
            }

            if !split.images.isEmpty {
                ForEach(
                    split.images,
                    id: \ChatMarkdownSplitter.InlineImage.id)
                { (item: ChatMarkdownSplitter.InlineImage) in
                    if let img = item.image {
                        ClawdisPlatformImageFactory.image(img)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 260)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                    } else {
                        Text(item.label.isEmpty ? "Image" : item.label)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .textSelection(.enabled)
    }
}

@MainActor
private struct CodeBlockView: View {
    let code: String
    let language: String?
    let isUser: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(self.code)
                .font(.system(size: 13, weight: .regular, design: .monospaced))
                .foregroundStyle(self.isUser ? .white : .primary)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(self.isUser ? Color.white.opacity(0.16) : Color.black.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
