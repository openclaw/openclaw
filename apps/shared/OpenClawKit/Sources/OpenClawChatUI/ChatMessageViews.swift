import OpenClawKit
import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 560
    static let bubbleCorner: CGFloat = 18
}

private struct ChatBubbleShape: InsettableShape {
    enum Tail {
        case left
        case right
        case none
    }

    let cornerRadius: CGFloat
    let tail: Tail
    var insetAmount: CGFloat = 0

    private let tailWidth: CGFloat = 7
    private let tailBaseHeight: CGFloat = 9

    func inset(by amount: CGFloat) -> ChatBubbleShape {
        var copy = self
        copy.insetAmount += amount
        return copy
    }

    func path(in rect: CGRect) -> Path {
        let rect = rect.insetBy(dx: self.insetAmount, dy: self.insetAmount)
        switch self.tail {
        case .left:
            return self.leftTailPath(in: rect, radius: self.cornerRadius)
        case .right:
            return self.rightTailPath(in: rect, radius: self.cornerRadius)
        case .none:
            return Path(roundedRect: rect, cornerRadius: self.cornerRadius)
        }
    }

    private func rightTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        var path = Path()
        let bubbleMinX = rect.minX
        let bubbleMaxX = rect.maxX - self.tailWidth
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY

        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        let baseTop = CGPoint(x: bubbleMaxX, y: baseTopY)
        let baseBottom = CGPoint(x: bubbleMaxX, y: baseBottomY)
        let tip = CGPoint(x: bubbleMaxX + self.tailWidth, y: midY)

        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        path.addLine(to: baseTop)
        path.addCurve(
            to: tip,
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseTopY + baseH * 0.05),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY - baseH * 0.15))
        path.addCurve(
            to: baseBottom,
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY + baseH * 0.15),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseBottomY - baseH * 0.05))
        self.addBottomEdge(path: &path, bubbleMinX: bubbleMinX, bubbleMaxX: bubbleMaxX, bubbleMaxY: bubbleMaxY, radius: r)
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))

        return path
    }

    private func leftTailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        var path = Path()
        let bubbleMinX = rect.minX + self.tailWidth
        let bubbleMaxX = rect.maxX
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY

        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        let baseTop = CGPoint(x: bubbleMinX, y: baseTopY)
        let baseBottom = CGPoint(x: bubbleMinX, y: baseBottomY)
        let tip = CGPoint(x: bubbleMinX - self.tailWidth, y: midY)

        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX, y: bubbleMaxY - r))
        self.addBottomEdge(path: &path, bubbleMinX: bubbleMinX, bubbleMaxX: bubbleMaxX, bubbleMaxY: bubbleMaxY, radius: r)
        path.addLine(to: baseBottom)
        path.addCurve(
            to: tip,
            control1: CGPoint(x: bubbleMinX - self.tailWidth * 0.2, y: baseBottomY - baseH * 0.05),
            control2: CGPoint(x: bubbleMinX - self.tailWidth * 0.95, y: midY + baseH * 0.15))
        path.addCurve(
            to: baseTop,
            control1: CGPoint(x: bubbleMinX - self.tailWidth * 0.95, y: midY - baseH * 0.15),
            control2: CGPoint(x: bubbleMinX - self.tailWidth * 0.2, y: baseTopY + baseH * 0.05))
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))

        return path
    }

    private func addBottomEdge(
        path: inout Path,
        bubbleMinX: CGFloat,
        bubbleMaxX: CGFloat,
        bubbleMaxY: CGFloat,
        radius: CGFloat)
    {
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX - radius, y: bubbleMaxY),
            control: CGPoint(x: bubbleMaxX, y: bubbleMaxY))
        path.addLine(to: CGPoint(x: bubbleMinX + radius, y: bubbleMaxY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX, y: bubbleMaxY - radius),
            control: CGPoint(x: bubbleMinX, y: bubbleMaxY))
    }
}

@MainActor
struct ChatMessageBubble: View {
    let message: OpenClawChatMessage
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let userAccent: Color?
    let showsAssistantTrace: Bool
    let requestToolResultDetail: @MainActor @Sendable (String) async -> String?

    var body: some View {
        ChatMessageBody(
            message: self.message,
            isUser: self.isUser,
            style: self.style,
            markdownVariant: self.markdownVariant,
            userAccent: self.userAccent,
            showsAssistantTrace: self.showsAssistantTrace,
            requestToolResultDetail: self.requestToolResultDetail)
            .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: self.isUser ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: self.isUser ? .trailing : .leading)
            .padding(.horizontal, 2)
    }

    private var isUser: Bool { self.message.role.lowercased() == "user" }
}

@MainActor
private struct ChatMessageBody: View {
    let message: OpenClawChatMessage
    let isUser: Bool
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let userAccent: Color?
    let showsAssistantTrace: Bool
    let requestToolResultDetail: @MainActor @Sendable (String) async -> String?

    var body: some View {
        let text = self.primaryText
        let textColor = self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText

        VStack(alignment: .leading, spacing: 10) {
            if ChatPlatformFeatures.showsExplicitCopyButton,
               let copyableText = self.copyableText
            {
                HStack {
                    Spacer(minLength: 0)
                    ChatCopyButton(text: copyableText)
                }
            }

            if self.isToolResultMessage {
                ToolResultDisclosureCard(
                    title: self.toolResultTitle,
                    toolCallId: self.message.toolCallId,
                    toolName: self.message.toolName,
                    requestDetail: self.requestToolResultDetail)
            } else if self.isSlashCommandMessage {
                SlashCommandEchoCard(text: text)
            } else if self.isUser {
                ChatMarkdownRenderer(
                    text: text,
                    context: .user,
                    variant: self.markdownVariant,
                    font: .system(size: 14),
                    textColor: textColor)
            } else {
                ChatAssistantTextBody(
                    text: text,
                    markdownVariant: self.markdownVariant,
                    includesThinking: self.showsAssistantTrace)
            }

            if !self.inlineAttachments.isEmpty {
                ForEach(self.inlineAttachments.indices, id: \.self) { idx in
                    AttachmentRow(att: self.inlineAttachments[idx], isUser: self.isUser)
                }
            }

            if !self.inlineToolResults.isEmpty {
                ForEach(self.inlineToolResults.indices, id: \.self) { idx in
                    let toolResult = self.inlineToolResults[idx]
                    let display = ToolDisplayRegistry.resolve(name: toolResult.name ?? "tool", args: nil)
                    ToolResultDisclosureCard(
                        title: "\(display.emoji) \(display.title)",
                        toolCallId: toolResult.id,
                        toolName: toolResult.name,
                        requestDetail: self.requestToolResultDetail)
                }
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .foregroundStyle(textColor)
        .background(self.bubbleBackground)
        .clipShape(self.bubbleShape)
        .overlay(self.bubbleBorder)
        .shadow(color: self.bubbleShadowColor, radius: self.bubbleShadowRadius, y: self.bubbleShadowYOffset)
        .padding(.leading, self.tailPaddingLeading)
        .padding(.trailing, self.tailPaddingTrailing)
        .copyContextMenu(text: self.copyableText)
    }

    private var primaryText: String {
        let parts = self.message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return nil }
            return content.text
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var inlineAttachments: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            switch content.type ?? "text" {
            case "file", "attachment":
                true
            default:
                false
            }
        }
    }

    private var toolCalls: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            if ["toolcall", "tool_call", "tooluse", "tool_use"].contains(kind) {
                return true
            }
            return content.name != nil && content.arguments != nil
        }
    }

    private var inlineToolResults: [OpenClawChatMessageContent] {
        self.message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            return kind == "toolresult" || kind == "tool_result"
        }
    }

    private var isToolResultMessage: Bool {
        let role = self.message.role.lowercased()
        return role == "toolresult" || role == "tool_result"
    }

    private var isSlashCommandMessage: Bool {
        guard self.isUser else { return false }
        guard self.inlineAttachments.isEmpty else { return false }
        let trimmed = self.primaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return false }
        let firstToken = trimmed.split(whereSeparator: \.isWhitespace).first
        return firstToken?.contains("/") == true
    }

    private var toolResultTitle: String {
        if let name = self.message.toolName, !name.isEmpty {
            let display = ToolDisplayRegistry.resolve(name: name, args: nil)
            return "\(display.emoji) \(display.title)"
        }
        let display = ToolDisplayRegistry.resolve(name: "tool", args: nil)
        return "\(display.emoji) \(display.title)"
    }

    private var bubbleFillColor: Color {
        if self.isUser {
            return self.userAccent ?? OpenClawChatTheme.userBubble
        }
        if self.style == .onboarding {
            return OpenClawChatTheme.onboardingAssistantBubble
        }
        return OpenClawChatTheme.assistantBubble
    }

    private var bubbleBackground: AnyShapeStyle {
        AnyShapeStyle(self.bubbleFillColor)
    }

    private var bubbleBorderColor: Color {
        if self.isUser {
            return Color.white.opacity(0.12)
        }
        if self.style == .onboarding {
            return OpenClawChatTheme.onboardingAssistantBorder
        }
        return Color.white.opacity(0.08)
    }

    private var bubbleBorderWidth: CGFloat {
        if self.isUser { return 0.5 }
        if self.style == .onboarding { return 0.8 }
        return 1
    }

    private var bubbleBorder: some View {
        self.bubbleShape.strokeBorder(self.bubbleBorderColor, lineWidth: self.bubbleBorderWidth)
    }

    private var bubbleShape: ChatBubbleShape {
        ChatBubbleShape(cornerRadius: ChatUIConstants.bubbleCorner, tail: self.bubbleTail)
    }

    private var bubbleTail: ChatBubbleShape.Tail {
        guard self.style == .onboarding else { return .none }
        return self.isUser ? .right : .left
    }

    private var tailPaddingLeading: CGFloat {
        self.style == .onboarding && !self.isUser ? 8 : 0
    }

    private var tailPaddingTrailing: CGFloat {
        self.style == .onboarding && self.isUser ? 8 : 0
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

    private var copyableText: String? {
        let text = self.primaryText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}

private struct SlashCommandEchoCard: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(self.text)
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                .foregroundStyle(OpenClawChatTheme.userText)
            Spacer(minLength: 0)
            if ChatPlatformFeatures.showsExplicitCopyButton {
                ChatCopyButton(text: self.text)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .chatMessageTextSelection()
        .background(Color.white.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .copyContextMenu(text: self.text)
    }
}

private struct ToolResultDisclosureCard: View {
    let title: String
    let toolCallId: String?
    let toolName: String?
    let requestDetail: @MainActor @Sendable (String) async -> String?
    @State private var expanded = false
    @State private var isLoading = false
    @State private var detailText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                self.toggleExpanded()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "hammer.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(self.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text("Tool output")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if ChatPlatformFeatures.showsExplicitCopyButton,
                       let detailText = self.detailText,
                       !detailText.isEmpty
                    {
                        ChatCopyButton(text: detailText)
                    }
                    Image(systemName: self.expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            if self.expanded {
                if self.isLoading {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Loading tool output…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else if let detailText, !detailText.isEmpty {
                    Text(detailText)
                        .font(.footnote.monospaced())
                        .foregroundStyle(OpenClawChatTheme.assistantText)
                        .lineLimit(12)
                        .chatMessageTextSelection()
                } else {
                    Text("Tool output unavailable.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private func toggleExpanded() {
        self.expanded.toggle()
        guard self.expanded else { return }
        guard self.detailText == nil else { return }
        guard let toolCallId = self.toolCallId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !toolCallId.isEmpty
        else {
            self.detailText = "Tool output unavailable."
            return
        }

        self.isLoading = true
        Task {
            let detail = await self.requestDetail(toolCallId)
            await MainActor.run {
                self.isLoading = false
                let formatted = detail.map { ToolResultTextFormatter.format(text: $0, toolName: self.toolName) } ?? ""
                self.detailText = formatted.isEmpty ? "Tool output unavailable." : formatted
            }
        }
    }
}

private struct AttachmentRow: View {
    let att: OpenClawChatMessageContent
    let isUser: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip")
            Text(self.att.fileName ?? "Attachment")
                .font(.footnote)
                .lineLimit(1)
                .foregroundStyle(self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText)
            Spacer()
        }
        .padding(10)
        .background(self.isUser ? Color.white.opacity(0.2) : Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct ToolCallCard: View {
    let content: OpenClawChatMessageContent
    let isUser: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "hammer.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(self.toolName)
                    .font(.footnote.weight(.semibold))
                Spacer(minLength: 0)
                Text("Running")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            if let summary = self.summary, !summary.isEmpty {
                Text(summary)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var toolName: String {
        "\(self.display.emoji) \(self.display.title)"
    }

    private var summary: String? {
        self.display.detailLine
    }

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.content.name ?? "tool", args: self.content.arguments)
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    let style: OpenClawChatView.Style

    var body: some View {
        HStack(spacing: 10) {
            TypingDots()
            Spacer(minLength: 0)
        }
        .padding(.vertical, self.style == .standard ? 12 : 10)
        .padding(.horizontal, self.style == .standard ? 12 : 14)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OpenClawChatTheme.assistantBubble))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
        .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
        .focusable(false)
    }
}

extension ChatTypingIndicatorBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.style == rhs.style
    }
}

private extension View {
    func assistantBubbleContainerStyle() -> some View {
        self
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(OpenClawChatTheme.assistantBubble))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .leading)
            .focusable(false)
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let showsAssistantTrace: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ChatAssistantTextBody(
                text: self.text,
                markdownVariant: self.markdownVariant,
                includesThinking: self.showsAssistantTrace)
        }
        .padding(12)
        .assistantBubbleContainerStyle()
        .copyContextMenu(text: self.text)
    }
}

@MainActor
struct ChatPendingToolsBubble: View {
    let toolCalls: [OpenClawChatPendingToolCall]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Running tools…", systemImage: "hammer")
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(self.toolCalls) { call in
                let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(display.emoji) \(display.label)")
                            .font(.footnote.monospaced())
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        ProgressView().controlSize(.mini)
                    }
                    if let detail = display.detailLine, !detail.isEmpty {
                        Text(detail)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(10)
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(12)
        .assistantBubbleContainerStyle()
    }
}

extension ChatPendingToolsBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.toolCalls == rhs.toolCalls
    }
}

@MainActor
private struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TimelineView(.animation(minimumInterval: self.reduceMotion ? 0.8 : 1.0 / 30.0)) { context in
            let phase = self.currentPhase(at: context.date)
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { idx in
                    let emphasis = self.emphasis(for: idx, phase: phase)
                    Circle()
                        .fill(Color.secondary.opacity(0.34 + (0.56 * emphasis)))
                        .frame(width: 7, height: 7)
                        .scaleEffect(0.74 + (0.42 * emphasis))
                        .opacity(0.28 + (0.72 * emphasis))
                        .offset(y: self.reduceMotion ? 0 : (1.8 - (4.8 * emphasis)))
                }
            }
        }
    }

    private func currentPhase(at date: Date) -> Double {
        guard !self.reduceMotion, self.scenePhase == .active else {
            return 0
        }
        let cycle = date.timeIntervalSinceReferenceDate * 2.1
        return cycle.truncatingRemainder(dividingBy: 3.0)
    }

    private func emphasis(for index: Int, phase: Double) -> Double {
        guard !self.reduceMotion, self.scenePhase == .active else {
            return index == 0 ? 0.7 : 0.35
        }
        let distance = min(
            abs(Double(index) - phase),
            abs(Double(index) - phase + 3.0),
            abs(Double(index) - phase - 3.0))
        let normalized = max(0, 1.0 - min(distance, 1.15) / 1.15)
        return normalized
    }
}

private struct ChatAssistantTextBody: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let includesThinking: Bool

    var body: some View {
        let segments = AssistantTextParser.segments(from: self.text, includeThinking: self.includesThinking)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                let font = segment.kind == .thinking ? Font.system(size: 14).italic() : Font.system(size: 14)
                ChatMarkdownRenderer(
                    text: segment.text,
                    context: .assistant,
                    variant: self.markdownVariant,
                    font: font,
                    textColor: OpenClawChatTheme.assistantText)
            }
        }
    }
}

private extension View {
    func chatMessageTextSelection() -> some View {
        self.textSelection(.enabled)
    }

    @ViewBuilder
    func copyContextMenu(text: String?) -> some View {
        if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.contextMenu {
                Button("Copy", systemImage: "doc.on.doc") {
                    ChatCopyboard.copy(text)
                }
            }
        } else {
            self
        }
    }
}

private struct ChatCopyButton: View {
    let text: String

    var body: some View {
        Button {
            ChatCopyboard.copy(self.text)
        } label: {
            Image(systemName: "doc.on.doc")
                .font(.caption.weight(.semibold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Copy")
    }
}

private enum ChatCopyboard {
    static func copy(_ text: String) {
#if canImport(UIKit)
        UIPasteboard.general.string = text
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
#endif
    }
}

private enum ChatPlatformFeatures {
    static var showsExplicitCopyButton: Bool {
#if canImport(UIKit)
        ProcessInfo.processInfo.isiOSAppOnMac
#else
        false
#endif
    }
}
