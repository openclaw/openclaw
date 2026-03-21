import OpenClawKit
import Foundation
import SwiftUI

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

    var body: some View {
        ChatMessageBody(
            message: self.message,
            isUser: self.isUser,
            style: self.style,
            markdownVariant: self.markdownVariant,
            userAccent: self.userAccent,
            showsAssistantTrace: self.showsAssistantTrace)
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

    var body: some View {
        let text = self.primaryText
        let textColor = self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText

        VStack(alignment: .leading, spacing: 10) {
            if self.isToolResultMessage, self.showsAssistantTrace {
                if !text.isEmpty {
                    ToolResultCard(
                        title: self.toolResultTitle,
                        text: text,
                        isUser: self.isUser,
                        toolName: self.message.toolName)
                }
            } else if self.isUser, self.isSystemMessage(text) {
                CollapsibleSystemMessage(text: text)
            } else if self.isUser, self.isSystemMessage(text) {
                CollapsibleSystemMessage(text: text)
            } else if self.isUser {
                ChatMarkdownRenderer(
                    text: text,
                    context: .user,
                    variant: self.markdownVariant,
                    font: .custom("Courier New", size: 12),
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

            if self.showsAssistantTrace, !self.toolCalls.isEmpty {
                ForEach(self.toolCalls.indices, id: \.self) { idx in
                    ToolCallCard(
                        content: self.toolCalls[idx],
                        isUser: self.isUser)
                }
            }

            if self.showsAssistantTrace, !self.inlineToolResults.isEmpty {
                ForEach(self.inlineToolResults.indices, id: \.self) { idx in
                    let toolResult = self.inlineToolResults[idx]
                    let display = ToolDisplayRegistry.resolve(name: toolResult.name ?? "tool", args: nil)
                    ToolResultCard(
                        title: "\(display.emoji) \(display.title)",
                        text: toolResult.text ?? "",
                        isUser: self.isUser,
                        toolName: toolResult.name)
                }
            }
        }
        .textSelection(.enabled)
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .foregroundStyle(textColor)
        .background(self.bubbleBackground)
        .clipShape(self.bubbleShape)
        .overlay(self.bubbleBorder)
        .shadow(color: self.bubbleShadowColor, radius: self.bubbleShadowRadius, y: self.bubbleShadowYOffset)
        .padding(.leading, self.tailPaddingLeading)
        .padding(.trailing, self.tailPaddingTrailing)
    }

    private func isSystemMessage(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = trimmed.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return false }
        return lines.allSatisfy { line in
            line.hasPrefix("System:") ||
            line.hasPrefix("An async command") ||
            line.hasPrefix("Current time:") ||
            line.hasPrefix("Handle the result internally")
        }
    }

    private var isSystemContent: Bool {
        guard self.isUser else { return false }
        return self.isSystemMessage(self.primaryText)
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

    private var toolResultTitle: String {
        if let name = self.message.toolName, !name.isEmpty {
            let display = ToolDisplayRegistry.resolve(name: name, args: nil)
            return "\(display.emoji) \(display.title)"
        }
        let display = ToolDisplayRegistry.resolve(name: "tool", args: nil)
        return "\(display.emoji) \(display.title)"
    }

    private var bubbleFillColor: Color {
        if self.isUser, self.isSystemContent {
            return Color(red: 38 / 255.0, green: 39 / 255.0, blue: 42 / 255.0)
        }
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
}

private struct AttachmentRow: View {
    let att: OpenClawChatMessageContent
    let isUser: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip")
            Text(self.att.fileName ?? "Attachment")
                .font(.system(size: 11, design: .monospaced))
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
            HStack(spacing: 6) {
                Text(self.toolName)
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                Spacer(minLength: 0)
            }

            if let summary = self.summary, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 11, design: .monospaced))
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

private struct ToolResultCard: View {
    let title: String
    let text: String
    let isUser: Bool
    let toolName: String?
    @State private var expanded = false

    var body: some View {
        if !self.displayContent.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text(self.title)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    Spacer(minLength: 0)
                }

                Text(self.displayText)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(self.isUser ? OpenClawChatTheme.userText : OpenClawChatTheme.assistantText)
                    .lineLimit(self.expanded ? nil : Self.previewLineLimit)

                if self.shouldShowToggle {
                    Button(self.expanded ? "Show less" : "Show full output") {
                        self.expanded.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
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
    }

    private static let previewLineLimit = 8

    private var displayContent: String {
        ToolResultTextFormatter.format(text: self.text, toolName: self.toolName)
    }

    private var lines: [Substring] {
        self.displayContent.components(separatedBy: .newlines).map { Substring($0) }
    }

    private var displayText: String {
        guard !self.expanded, self.lines.count > Self.previewLineLimit else { return self.displayContent }
        return self.lines.prefix(Self.previewLineLimit).joined(separator: "\n") + "\n…"
    }

    private var shouldShowToggle: Bool {
        self.lines.count > Self.previewLineLimit
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    let style: OpenClawChatView.Style

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(Color(red: 1.0, green: 0.75, blue: 0.2))
            Text("⏳ thinking…")
                .font(.custom("Courier New Bold", size: 10))
                .foregroundStyle(Color(red: 1.0, green: 0.75, blue: 0.2))
            ElapsedTimerView()
            Spacer(minLength: 0)
        }
        .padding(.vertical, self.style == .standard ? 8 : 6)
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

@MainActor
private struct ElapsedTimerView: View {
    @State private var elapsed: TimeInterval = 0
    @State private var startDate = Date()
    private let timer = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect()

    var body: some View {
        Text(self.formattedTime)
            .font(.custom("Courier New", size: 10))
            .foregroundStyle(Color.secondary.opacity(0.6))
            .onReceive(self.timer) { _ in
                self.elapsed = Date().timeIntervalSince(self.startDate)
            }
    }

    private var formattedTime: String {
        let secs = Int(self.elapsed)
        let tenths = Int((self.elapsed - Double(secs)) * 10)
        if secs < 60 {
            return String(format: "%d.%ds", secs, tenths)
        }
        let mins = secs / 60
        let remainSecs = secs % 60
        return String(format: "%d:%02d", mins, remainSecs)
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
    }
}

@MainActor
struct ChatPendingToolsBubble: View {
    let toolCalls: [OpenClawChatPendingToolCall]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(self.toolCalls) { call in
                let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Color(red: 1.0, green: 0.75, blue: 0.2))
                    Text("\(display.emoji) \(display.label)")
                        .font(.custom("Courier New Bold", size: 10))
                        .foregroundStyle(Color(red: 1.0, green: 0.75, blue: 0.2))
                    if let detail = display.detailLine, !detail.isEmpty {
                        Text(detail)
                            .font(.custom("Courier New", size: 9))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let startedAt = call.startedAt {
                        ToolElapsedView(startedAt: startedAt)
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .assistantBubbleContainerStyle()
    }
}

extension ChatPendingToolsBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.toolCalls == rhs.toolCalls
    }
}

@MainActor
private struct ToolElapsedView: View {
    let startedAt: Double
    @State private var elapsed: TimeInterval = 0
    private let timer = Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()
    var body: some View {
        Text(self.formattedTime)
            .font(.custom("Courier New", size: 9))
            .foregroundStyle(Color.secondary.opacity(0.5))
            .onAppear { self.elapsed = max(0, Date().timeIntervalSince1970 - self.startedAt / 1000) }
            .onReceive(self.timer) { _ in self.elapsed = max(0, Date().timeIntervalSince1970 - self.startedAt / 1000) }
    }
    private var formattedTime: String {
        let secs = Int(self.elapsed)
        if secs < 60 { return "\(secs)s" }
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }
}


@MainActor
private struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
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
        .onAppear { self.updateAnimationState() }
        .onDisappear { self.animate = false }
        .onChange(of: self.scenePhase) { _, _ in
            self.updateAnimationState()
        }
        .onChange(of: self.reduceMotion) { _, _ in
            self.updateAnimationState()
        }
    }

    private func updateAnimationState() {
        guard !self.reduceMotion, self.scenePhase == .active else {
            self.animate = false
            return
        }
        self.animate = true
    }
}

@MainActor
private struct CollapsibleSystemMessage: View {
    let text: String
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { withAnimation(.easeInOut(duration: 0.2)) { self.isExpanded.toggle() } }) {
                HStack(spacing: 6) {
                    Image(systemName: self.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .frame(width: 10)
                    Image(systemName: "terminal")
                        .font(.system(size: 10))
                        .foregroundStyle(Color.secondary.opacity(0.5))
                    Text(self.previewText)
                        .font(.custom("Courier New", size: 10))
                        .foregroundStyle(Color.secondary.opacity(0.6))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            if self.isExpanded {
                Text(self.text)
                    .font(.custom("Courier New", size: 10))
                    .foregroundStyle(Color.secondary.opacity(0.7))
                    .textSelection(.enabled)
                    .padding(.leading, 16)
            }
        }
    }

    private var previewText: String {
        let firstLine = self.text.components(separatedBy: .newlines).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) ?? "System message"
        let cleaned = firstLine
            .replacingOccurrences(of: "System: ", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.count > 60 {
            return String(cleaned.prefix(60)) + "…"
        }
        return cleaned
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
                let font = segment.kind == .thinking ? Font.custom("Courier New Italic", size: 12) : Font.custom("Courier New", size: 12)
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
