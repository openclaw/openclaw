import Foundation
import SwiftUI

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 560
    static let bubbleCorner: CGFloat = 18
}

private struct BubbleTail: Shape {
    enum TailDirection: CaseIterable, Identifiable {
        case topRight
        case topLeft
        case bottomLeft
        case bottomRight

        var id: Self { self }
    }

    let direction: TailDirection

    func path(in rect: CGRect) -> Path {
        Path { path in
            switch direction {
            case .topRight:
                let startPoint = CGPoint(x: rect.minX, y: rect.maxY)
                path.move(to: startPoint)
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
                let control1 = CGPoint(x: rect.maxX - rect.maxX / 20, y: rect.minY - rect.maxY / 3)
                let control2 = CGPoint(x: rect.maxX * 5 / 6, y: rect.maxY * 5 / 6)
                path.addCurve(to: startPoint, control1: control1, control2: control2)
            case .topLeft:
                let startPoint = CGPoint(x: rect.maxX, y: rect.maxY)
                path.move(to: startPoint)
                path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
                path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
                let control1 = CGPoint(x: rect.maxX / 20, y: rect.minY - rect.maxY / 3)
                let control2 = CGPoint(x: rect.maxX * 1 / 6, y: rect.maxY * 5 / 6)
                path.addCurve(to: startPoint, control1: control1, control2: control2)
            case .bottomLeft:
                let startPoint = CGPoint(x: rect.minX, y: rect.maxY)
                path.move(to: startPoint)
                path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
                let control1 = CGPoint(x: rect.maxX / 6, y: rect.maxY / 6)
                let control2 = CGPoint(x: rect.minX + rect.maxX / 20, y: rect.maxY + rect.maxY / 3)
                path.addCurve(to: startPoint, control1: control1, control2: control2)
            case .bottomRight:
                let startPoint = CGPoint(x: rect.minX, y: rect.minY)
                path.move(to: startPoint)
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
                path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
                let control1 = CGPoint(x: rect.maxX - rect.maxX / 20, y: rect.maxY + rect.maxY / 3)
                let control2 = CGPoint(x: rect.maxX * 5 / 6, y: rect.maxY * 1 / 6)
                path.addCurve(to: startPoint, control1: control1, control2: control2)
            }
        }
    }
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
        .clipShape(self.bubbleShape)
        .overlay(alignment: self.tailAlignment) {
            if let tailDirection = self.tailDirection {
                BubbleTail(direction: tailDirection)
                    .fill(self.bubbleFillColor)
                    .frame(width: self.tailSize.width, height: self.tailSize.height)
                    .offset(x: self.tailOffsetX, y: self.tailOffsetY)
            }
        }
        .overlay(alignment: self.tailAlignment) {
            if let tailDirection = self.tailDirection {
                BubbleTail(direction: tailDirection)
                    .stroke(self.bubbleBorderColor, lineWidth: self.bubbleBorderWidth)
                    .frame(width: self.tailSize.width, height: self.tailSize.height)
                    .offset(x: self.tailOffsetX, y: self.tailOffsetY)
            }
        }
        .shadow(color: self.bubbleShadowColor, radius: self.bubbleShadowRadius, y: self.bubbleShadowYOffset)
        .padding(.leading, self.tailPaddingLeading)
        .padding(.trailing, self.tailPaddingTrailing)
    }

    private var primaryText: String {
        let parts = self.message.content.compactMap(\.text)
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var inlineAttachments: [ClawdisChatMessageContent] {
        self.message.content.filter { ($0.type ?? "text") != "text" }
    }

    private var bubbleFillColor: Color {
        if self.isUser {
            return ClawdisChatTheme.userBubble
        }
        if self.style == .onboarding {
            return ClawdisChatTheme.onboardingAssistantBubble
        }
        return ClawdisChatTheme.assistantBubble
    }

    private var bubbleBackground: AnyShapeStyle {
        AnyShapeStyle(self.bubbleFillColor)
    }

    private var bubbleBorderColor: Color {
        if self.isUser {
            return Color.white.opacity(0.12)
        }
        if self.style == .onboarding {
            return ClawdisChatTheme.onboardingAssistantBorder
        }
        return Color.black.opacity(0.08)
    }

    private var bubbleBorderWidth: CGFloat {
        if self.isUser { return 0.5 }
        if self.style == .onboarding { return 0.8 }
        return 1
    }

    private var bubbleBorder: some View {
        RoundedRectangle(cornerRadius: ChatUIConstants.bubbleCorner, style: .continuous)
            .strokeBorder(self.bubbleBorderColor, lineWidth: self.bubbleBorderWidth)
            .clipShape(self.bubbleShape)
    }

    private var bubbleShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: ChatUIConstants.bubbleCorner, style: .continuous)
    }

    private var tailDirection: BubbleTail.TailDirection? {
        guard self.style == .onboarding else { return nil }
        return self.isUser ? .bottomRight : .bottomLeft
    }

    private var tailAlignment: Alignment {
        self.isUser ? .bottomTrailing : .bottomLeading
    }

    private var tailSize: CGSize {
        CGSize(width: 16, height: 22)
    }

    private var tailOffsetX: CGFloat {
        self.isUser ? 6 : -6
    }

    private var tailOffsetY: CGFloat {
        4
    }

    private var tailPaddingLeading: CGFloat {
        self.style == .onboarding && !self.isUser ? 6 : 0
    }

    private var tailPaddingTrailing: CGFloat {
        self.style == .onboarding && self.isUser ? 6 : 0
    }

    private var bubbleShadowColor: Color {
        self.style == .onboarding && !self.isUser ? Color.black.opacity(0.28) : .clear
    }

    private var bubbleShadowRadius: CGFloat {
        self.style == .onboarding && !self.isUser ? 6 : 0
    }

    private var bubbleShadowYOffset: CGFloat {
        self.style == .onboarding && !self.isUser ? 2 : 0
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
        let normalized = self.text.replacingOccurrences(
            of: "(?<!\\n)\\n(?!\\n)",
            with: " \\n",
            options: .regularExpression)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: normalized, options: options) {
            Text(attributed)
                .font(.system(size: 14))
                .foregroundStyle(self.textColor)
        } else {
            Text(normalized)
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
