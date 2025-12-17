import Foundation
import SwiftUI

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 760
    static let bubbleCorner: CGFloat = 16
}

@MainActor
struct ChatMessageBubble: View {
    let message: ClawdisChatMessage

    var body: some View {
        VStack(alignment: self.isUser ? .trailing : .leading, spacing: 8) {
            HStack(spacing: 8) {
                if !self.isUser {
                    Label("Assistant", systemImage: "sparkles")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if self.isUser {
                    Label("You", systemImage: "person.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ChatMessageBody(message: self.message, isUser: self.isUser)
                .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: self.isUser ? .trailing : .leading)
        }
        .padding(.horizontal, 2)
    }

    private var isUser: Bool { self.message.role.lowercased() == "user" }
}

@MainActor
private struct ChatMessageBody: View {
    let message: ClawdisChatMessage
    let isUser: Bool

    var body: some View {
        let text = self.primaryText
        let split = ChatMarkdownSplitter.split(markdown: text)

        VStack(alignment: .leading, spacing: 10) {
            ForEach(split.blocks) { block in
                switch block.kind {
                case .text:
                    MarkdownTextView(text: block.text)
                case let .code(language):
                    CodeBlockView(code: block.text, language: language)
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
                    AttachmentRow(att: self.inlineAttachments[idx])
                }
            }
        }
        .textSelection(.enabled)
        .padding(12)
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
        if self.isUser {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [
                        Color.orange.opacity(0.22),
                        Color.accentColor.opacity(0.18),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing))
        }
        return AnyShapeStyle(ClawdisChatTheme.subtleCard)
    }

    private var bubbleBorder: some View {
        RoundedRectangle(cornerRadius: ChatUIConstants.bubbleCorner, style: .continuous)
            .strokeBorder(self.isUser ? Color.orange.opacity(0.35) : Color.white.opacity(0.10), lineWidth: 1)
    }
}

private struct AttachmentRow: View {
    let att: ClawdisChatMessageContent

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip")
            Text(self.att.fileName ?? "Attachment")
                .font(.footnote)
                .lineLimit(1)
            Spacer()
        }
        .padding(10)
        .background(Color.white.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    var body: some View {
        HStack(spacing: 10) {
            TypingDots()
            Text("Clawd is thinking…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ClawdisChatTheme.subtleCard))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Assistant (streaming)", systemImage: "sparkles")
                .font(.caption)
                .foregroundStyle(.secondary)

            ChatMarkdownBody(text: self.text)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(ClawdisChatTheme.subtleCard))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
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
                .fill(ClawdisChatTheme.subtleCard))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
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

    var body: some View {
        if let attributed = try? AttributedString(markdown: self.text) {
            Text(attributed)
                .font(.system(size: 14))
                .foregroundStyle(.primary)
        } else {
            Text(self.text)
                .font(.system(size: 14))
                .foregroundStyle(.primary)
        }
    }
}

@MainActor
private struct ChatMarkdownBody: View {
    let text: String

    var body: some View {
        let split = ChatMarkdownSplitter.split(markdown: self.text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(split.blocks) { block in
                switch block.kind {
                case .text:
                    MarkdownTextView(text: block.text)
                case let .code(language):
                    CodeBlockView(code: block.text, language: language)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(self.code)
                .font(.system(size: 13, weight: .regular, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.black.opacity(0.06))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
