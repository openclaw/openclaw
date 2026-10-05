import Foundation
import OpenClawKit
import SwiftUI

struct ChatSystemNoticeRow: View {
    let notice: ChatTranscriptRow.SystemNotice
    // periphery:ignore - Read and written through $isExpanded; Xcode 27 omits the projected-binding reference.
    @State private var isExpanded = false

    var body: some View {
        if self.notice.collapsesBody {
            DisclosureGroup(isExpanded: self.$isExpanded) {
                Text(self.notice.body)
                    .font(OpenClawChatTypography.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
            } label: {
                ChatSystemLine(
                    systemImage: self.notice.systemImage,
                    label: self.notice.label,
                    metric: nil)
            }
            .foregroundStyle(.secondary)
            .tint(.secondary)
            .padding(.vertical, 4)
        } else {
            VStack(spacing: 8) {
                ChatSystemLine(
                    systemImage: self.notice.systemImage,
                    label: self.notice.label,
                    metric: nil)
                Text(self.notice.body)
                    .font(OpenClawChatTypography.footnote)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            .foregroundStyle(.secondary)
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "\(self.notice.label), \(self.notice.body)"))
        }
    }
}

struct ChatHistoryDividerRow: View {
    let divider: ChatTranscriptRow.HistoryDivider

    var body: some View {
        VStack(spacing: 6) {
            ChatSystemLine(
                systemImage: self.divider.systemImage,
                label: self.divider.label,
                metric: self.divider.metric)
            if let description = self.divider.description {
                Text(description)
                    .font(OpenClawChatTypography.caption)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.accessibilityLabel)
    }

    private var accessibilityLabel: String {
        [self.divider.label, self.divider.metric, self.divider.description]
            .compactMap(\.self)
            .joined(separator: ", ")
    }
}

private struct ChatSystemLine: View {
    let systemImage: String
    let label: String
    let metric: String?

    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
            HStack(spacing: 5) {
                Image(systemName: self.systemImage)
                    .font(.system(size: 11, weight: .medium))
                    .accessibilityHidden(true)
                Text(self.label.uppercased())
                    .font(OpenClawChatTypography.captionSemiBold)
                    .tracking(0.5)
                if let metric {
                    Text("·")
                        .font(OpenClawChatTypography.caption)
                        .accessibilityHidden(true)
                    Text(metric)
                        .font(OpenClawChatTypography.caption)
                        .monospacedDigit()
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            // The rules take what the label leaves; equal thirds truncated any label longer than a third of the row.
            .layoutPriority(1)
            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
        }
    }
}

private enum ChatUIConstants {
    static let bubbleMaxWidth: CGFloat = 560
    static let bubbleCorner: CGFloat = 18
}

struct ChatAgentAvatar: View {
    let text: String?
    let name: String?
    let tint: Color?
    var size: CGFloat = 30

    var body: some View {
        Text(self.displayText)
            .font(OpenClawChatTypography.avatar(size: self.fontSize))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .frame(width: self.size, height: self.size)
            .background(
                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                (self.tint ?? OpenClawChatTheme.accent).opacity(0.95),
                                Color(red: 38 / 255.0, green: 40 / 255.0, blue: 43 / 255.0),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing)))
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
            .shadow(color: (self.tint ?? OpenClawChatTheme.accent).opacity(0.18), radius: 8, y: 4)
            .accessibilityLabel(self.name.map {
                String(
                    format: String(localized: "%@ avatar"),
                    $0)
            } ?? String(localized: "Agent avatar"))
    }

    private var displayText: String {
        if let text = self.text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return String(text.prefix(3))
        }
        if let name = self.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            let words = name.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" }).prefix(2)
            let initials = words.compactMap(\.first).map(String.init).joined()
            if !initials.isEmpty {
                return initials.uppercased()
            }
        }
        return "OC"
    }

    private var fontSize: CGFloat {
        self.displayText.count > 2 ? self.size * 0.34 : self.size * 0.42
    }
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
    /// The messaging-app tail at the bottom corner, in place of the small side notch.
    var cornerTail = false

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
        case .left, .right:
            return self.cornerTail
                ? self.cornerTailPath(in: rect, radius: self.cornerRadius)
                : self.tailPath(in: rect, radius: self.cornerRadius)
        case .none:
            return Path(roundedRect: rect, cornerRadius: self.cornerRadius)
        }
    }

    static let cornerTailWidth: CGFloat = 7

    /// The side of the bubble sweeps out to a point at the bottom corner on the sender's side; the underside of
    /// that point curves up to a notch and back down to the bottom edge. Drawn for the left, mirrored for the right.
    private func cornerTailPath(in rect: CGRect, radius: CGFloat) -> Path {
        let bodyMinX = rect.minX + Self.cornerTailWidth
        // A very small bubble gets smaller corners and a shorter tail, so the outline never crosses itself.
        let r = max(0, min(radius, (rect.maxX - bodyMinX) / 2, rect.height / 2))
        let rise = min(15, max(0, rect.height - r))
        let flatX = min(bodyMinX + 21, rect.maxX - r)
        let notch = CGPoint(x: min(bodyMinX + 9, flatX), y: rect.maxY - min(4, rect.height / 2))
        var path = Path()
        path.move(to: CGPoint(x: bodyMinX + r, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        path.addQuadCurve(to: CGPoint(x: rect.maxX, y: rect.minY + r), control: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        path.addQuadCurve(to: CGPoint(x: rect.maxX - r, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: flatX, y: rect.maxY))
        path.addQuadCurve(to: notch, control: CGPoint(x: notch.x + (flatX - notch.x) * 0.45, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY),
            control: CGPoint(x: bodyMinX + (notch.x - bodyMinX) * 0.45, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: bodyMinX, y: rect.maxY - rise),
            control: CGPoint(x: bodyMinX, y: rect.maxY - rise * 0.22))
        path.addLine(to: CGPoint(x: bodyMinX, y: rect.minY + r))
        path.addQuadCurve(to: CGPoint(x: bodyMinX + r, y: rect.minY), control: CGPoint(x: bodyMinX, y: rect.minY))
        path.closeSubpath()
        guard self.tail == .right else { return path }
        return path.applying(CGAffineTransform(translationX: rect.minX + rect.maxX, y: 0).scaledBy(x: -1, y: 1))
    }

    private func tailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        let isRight = self.tail == .right
        let bubbleMinX = rect.minX + (isRight ? 0 : self.tailWidth)
        let bubbleMaxX = rect.maxX - (isRight ? self.tailWidth : 0)
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY
        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(self.tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        func addTail(to path: inout Path) {
            let edgeX = isRight ? bubbleMaxX : bubbleMinX
            let direction: CGFloat = isRight ? 1 : -1
            let startY = isRight ? baseTopY : baseBottomY
            let endY = isRight ? baseBottomY : baseTopY
            path.addLine(to: CGPoint(x: edgeX, y: startY))
            path.addCurve(
                to: CGPoint(x: edgeX + direction * self.tailWidth, y: midY),
                control1: CGPoint(x: edgeX + direction * self.tailWidth * 0.2, y: startY + direction * baseH * 0.05),
                control2: CGPoint(x: edgeX + direction * self.tailWidth * 0.95, y: midY - direction * baseH * 0.15))
            path.addCurve(
                to: CGPoint(x: edgeX, y: endY),
                control1: CGPoint(x: edgeX + direction * self.tailWidth * 0.95, y: midY + direction * baseH * 0.15),
                control2: CGPoint(x: edgeX + direction * self.tailWidth * 0.2, y: endY - direction * baseH * 0.05))
        }

        var path = Path()
        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        if isRight {
            addTail(to: &path)
        } else {
            path.addLine(to: CGPoint(x: bubbleMaxX, y: bubbleMaxY - r))
        }
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX - r, y: bubbleMaxY),
            control: CGPoint(x: bubbleMaxX, y: bubbleMaxY))
        path.addLine(to: CGPoint(x: bubbleMinX + r, y: bubbleMaxY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX, y: bubbleMaxY - r),
            control: CGPoint(x: bubbleMinX, y: bubbleMaxY))
        if !isRight {
            addTail(to: &path)
        }
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))
        return path
    }
}

@MainActor
struct ChatMessageBubble: View {
    @Environment(\.openClawAssistantUsesReadingColumn) private var usesReadingColumn
    @Environment(\.openClawAssistantBubblesInCleanChrome) private var assistantBubblesInClean
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    let message: OpenClawChatMessage
    var liveToolCalls: [OpenClawChatPendingToolCall] = []
    var metadata: ChatMessageMetadata?
    var sourcePreviews: [ChatSourcePreview] = []
    var sourceContextRevision = UUID()
    var sourceFaviconsEnabled = false
    var loadSourceFavicon: @MainActor @Sendable (String) async -> Data? = { _ in nil }
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let userAccent: Color?
    let displayOptions: OpenClawChatDisplayOptions
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool
    let contextWindowTokens: Int?
    let userMessageExpanded: Bool
    let onToggleUserMessageExpanded: @MainActor () -> Void
    let inlineWidgetResolverReady: Bool
    let inlineWidgetResourceResolver: @MainActor @Sendable (
        String,
        OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    let mediaArtifactResolverReady: Bool
    let mediaPlaybackAllowed: @MainActor @Sendable () -> Bool
    let loadMediaArtifact: @MainActor @Sendable (
        String,
        OpenClawChatMediaKind,
        OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?

    var body: some View {
        if self.isUser {
            self.messageBody
                .frame(maxWidth: ChatUIConstants.bubbleMaxWidth, alignment: .trailing)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 2)
        } else {
            HStack(alignment: .top, spacing: 8) {
                if self.showsAssistantAvatar {
                    ChatAgentAvatar(
                        text: self.assistantAvatarText,
                        name: self.assistantName,
                        tint: self.assistantAvatarTint)
                        .padding(.top, 1)
                }

                self.messageBody
                    .frame(
                        maxWidth: self.usesReadingColumn ? .infinity : ChatUIConstants.bubbleMaxWidth,
                        alignment: .leading)
                    .contentShape(.accessibility, Rectangle())
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chat-assistant-message-body")
                    .assistantSpeakerLabel(
                        self.assistantName,
                        avatarHidden: !self.showsAssistantAvatar)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
        }
    }

    private var isUser: Bool {
        self.message.role.lowercased() == "user"
    }
}

enum ChatUserMessageDisclosurePolicy {
    static let collapsedLineLimit = 12
    static let collapsedCharacterLimit = 700

    static func collapsedPreview(_ text: String) -> String? {
        var end = Self.stringIndex(atUTF16Offset: min(text.utf16.count, Self.collapsedCharacterLimit), in: text)
        var lineCount = 1
        for index in text.indices where index < end {
            guard text[index] == "\n" else { continue }
            if lineCount == Self.collapsedLineLimit {
                end = index
                break
            }
            lineCount += 1
        }
        guard end < text.endIndex else { return nil }
        return String(text[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    private static func stringIndex(atUTF16Offset offset: Int, in text: String) -> String.Index {
        var safeOffset = offset
        while safeOffset > 0 {
            let utf16Index = text.utf16.index(text.utf16.startIndex, offsetBy: safeOffset)
            if let index = String.Index(utf16Index, within: text) {
                return index
            }
            safeOffset -= 1
        }
        return text.startIndex
    }
}

extension ChatMessageBubble {
    @ViewBuilder
    private var messageBody: some View {
        let text = self.primaryText
        let textColor = self.textColor
        let shouldRenderBubble = self.shouldRenderBubble
        let toolActivityItems = self.toolActivityItems
        let hasOnboardingShadow = self.style == .onboarding && !self.isUser

        VStack(alignment: .leading, spacing: 6) {
            if shouldRenderBubble {
                if self.usesBubble {
                    self.messageContent(text: text, textColor: textColor)
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                        .padding(self.isUser ? .trailing : .leading, self.tailInset)
                        .background(AnyShapeStyle(self.bubbleFillColor))
                        .clipShape(self.bubbleShape)
                        // A round join keeps the outline of the tail's point inside the bubble's bounds.
                        .overlay(self.bubbleShape.strokeBorder(
                            self.bubbleBorderColor,
                            style: StrokeStyle(
                                lineWidth: self.bubbleBorderWidth,
                                lineJoin: self.style == .onboarding ? .miter : .round)))
                        .shadow(
                            color: hasOnboardingShadow ? Color.black.opacity(0.28) : .clear,
                            radius: hasOnboardingShadow ? 6 : 0,
                            y: hasOnboardingShadow ? 2 : 0)
                        .padding(.leading, self.tailPaddingLeading)
                        .padding(.trailing, self.tailPaddingTrailing)
                } else {
                    self.messageContent(text: text, textColor: textColor)
                        .padding(.vertical, 5)
                        .padding(.horizontal, 4)
                }
            }

            if !toolActivityItems.isEmpty {
                ChatToolActivityList(items: toolActivityItems)
                    .padding(.horizontal, 4)
            }

            if !shouldRenderBubble {
                self.footer
                    .padding(.horizontal, 4)
            }
        }
    }

    private var textColor: Color {
        if self.isDesktopLayout {
            return OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
        }
        return self.isUser
            ? OpenClawChatTheme.userText(on: self.userAccent)
            : OpenClawChatTheme.assistantText
    }

    private func messageContent(text: String, textColor: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.isUser {
                self.userMessageText(text: text, textColor: textColor)
            } else {
                ChatAssistantTextBody(
                    text: text,
                    markdownVariant: self.markdownVariant,
                    includesThinking: self.displayOptions.contains(.reasoning),
                    textColor: textColor)
            }

            if !self.sourcePreviews.isEmpty {
                ChatSourcePreviewsView(
                    sources: self.sourcePreviews,
                    contextRevision: self.sourceContextRevision,
                    faviconsEnabled: self.sourceFaviconsEnabled,
                    loadFavicon: self.loadSourceFavicon)
            }

            if let previewURL = self.linkPreviewURL {
                ChatLinkPreview(url: previewURL)
            }

            if !self.visibleInlineAttachments.isEmpty {
                ForEach(self.visibleInlineAttachments.indices, id: \.self) { idx in
                    AttachmentRow(
                        att: self.visibleInlineAttachments[idx],
                        isUser: self.isUser,
                        textColor: textColor,
                        resolverReady: self.mediaArtifactResolverReady,
                        playbackAllowed: self.mediaPlaybackAllowed,
                        loadMedia: self.loadMediaArtifact)
                }
            }

            if self.omittedImageAttachmentCount > 0 {
                Text(String(
                    format: String(localized: "Additional images hidden: %lld"),
                    Int64(self.omittedImageAttachmentCount)))
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(self.inlineWidgets.indices, id: \.self) { idx in
                ChatInlineWidgetView(
                    preview: self.inlineWidgets[idx],
                    resolverReady: self.inlineWidgetResolverReady,
                    resolveResource: self.inlineWidgetResourceResolver)
            }

            self.footer
        }
        .textSelection(.enabled)
        .foregroundStyle(textColor)
    }

    @ViewBuilder
    private func userMessageText(text: String, textColor: Color) -> some View {
        let preview = ChatUserMessageDisclosurePolicy.collapsedPreview(text)

        if let preview, !self.userMessageExpanded {
            Text(preview)
                .font(OpenClawChatTypography.body)
                .foregroundStyle(textColor)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            ChatMarkdownRenderer(
                text: text,
                context: .user,
                variant: self.markdownVariant,
                textColor: textColor)
        }

        if preview != nil {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    self.onToggleUserMessageExpanded()
                }
            } label: {
                Text(String(localized: self.userMessageExpanded ? "Show less" : "Show more"))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(textColor.opacity(self.isDesktopLayout ? 1 : 0.78))
                    .padding(.horizontal, 10)
                    .frame(minHeight: 30)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.white.opacity(self.isDesktopLayout ? 0.04 : 0.14)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .accessibilityValue(String(
                localized: self.userMessageExpanded ? "Expanded" : "Collapsed"))
            .accessibilityIdentifier("chat-user-message-disclosure-toggle")
        }
    }

    @ViewBuilder
    private var footer: some View {
        if self.metadata != nil || self.usagePresentation != nil {
            HStack(spacing: 8) {
                if let metadata = self.metadata {
                    ChatMessageMetadataView(metadata: metadata)
                }
                if let usage = self.usagePresentation {
                    self.usageLine(usage)
                }
            }
            .lineLimit(1)
        }
    }

    private func usageLine(_ presentation: ChatMessageUsagePresentation) -> some View {
        Text(presentation.text)
            .font(OpenClawChatTypography.caption2)
            .monospacedDigit()
            .foregroundStyle(self.usageTint(presentation.pressure))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "Message usage"))
            .accessibilityValue(presentation.accessibilityValue)
    }

    private var usesBubble: Bool {
        // Keep the guarded base condition; iOS additionally opts assistant
        // messages into bubbles via the clean-chrome environment flag.
        if self.isUser { return true }
        return self.style == .onboarding || !self.isClean || self.assistantBubblesInClean
    }

    private var shouldRenderBubble: Bool {
        guard !self.message.isToolResult else { return false }
        return !self.primaryText.isEmpty ||
            !self.inlineAttachments.isEmpty ||
            !self.inlineWidgets.isEmpty ||
            self.linkPreviewURL != nil
    }

    private var toolActivityItems: [ChatToolActivityItem] {
        guard self.displayOptions.contains(.toolActivity) else { return [] }
        // Results normally reach us merged into the calling assistant message
        // (ChatTranscriptRow.mergeToolResults); this branch is the orphan
        // fallback for results whose call is not in the preceding message.
        if self.message.isToolResult {
            return [ChatToolActivityItem(
                id: self.message.content.first?.id ?? "result-0",
                name: self.message.toolName,
                arguments: nil,
                details: self.message.details,
                resultText: self.primaryText,
                state: ChatToolActivity
                    .resultIsError(self.message.isError, text: self.primaryText) ? .failed : .finished,
                liveDiffStat: nil,
                activity: self.message.activity?.first,
                activityPrepared: self.message.activity != nil)]
        }
        guard self.message.role.lowercased() == "assistant" else { return [] }
        return ChatToolActivity.items(
            calls: self.message.content.filter(\.isToolCall),
            results: self.message.content.filter(\.isToolResult),
            activity: self.message.activity,
            liveTools: self.liveToolCalls)
    }

    private var linkPreviewURL: URL? {
        let role = self.message.role.lowercased()
        guard role == "user" || role == "assistant",
              let url = chatFirstPreviewURL(in: self.primaryText),
              role != "assistant" || !self.sourcePreviews.contains(where: { $0.represents(url) })
        else { return nil }
        return url
    }

    private var primaryText: String {
        ChatMessageVisibleText.displayText(
            in: self.message,
            includeThinking: self.displayOptions.contains(.reasoning))
    }

    private var inlineAttachments: [OpenClawChatMessageContent] {
        self.message.content.filter(\.isInlineAttachment)
    }

    private var visibleInlineAttachments: [OpenClawChatMessageContent] {
        var imageCount = 0
        return self.inlineAttachments.filter { attachment in
            guard attachment.mediaKind == .image else { return true }
            defer { imageCount += 1 }
            return imageCount < 4
        }
    }

    private var omittedImageAttachmentCount: Int {
        max(0, self.inlineAttachments.filter { $0.mediaKind == .image }.count - 4)
    }

    private var inlineWidgets: [OpenClawChatCanvasPreview] {
        guard self.message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
        else { return [] }
        return self.message.content.compactMap { content in
            guard (content.type ?? "").lowercased() == "canvas",
                  content.preview?.inlineWidgetPath != nil
            else { return nil }
            return content.preview
        }
    }

    private var usagePresentation: ChatMessageUsagePresentation? {
        ChatMessageUsagePresentation.make(
            message: self.message,
            contextWindowTokens: self.contextWindowTokens)
    }

    private func usageTint(_ pressure: ChatMessageUsagePresentation.Pressure) -> Color {
        switch pressure {
        case .normal:
            OpenClawChatTheme.muted
        case .warning:
            OpenClawChatTheme.warning
        case .danger:
            OpenClawChatTheme.danger
        }
    }

    private var bubbleFillColor: Color {
        if self.isUser {
            if self.isDesktopLayout {
                return OpenClawChatTheme.desktopUserBubble(in: self.colorScheme, accent: self.userAccent)
            }
            return self.userAccent ?? OpenClawChatTheme.userBubble
        }
        if self.style == .onboarding {
            return OpenClawChatTheme.onboardingAssistantBubble
        }
        return OpenClawChatTheme.assistantBubble
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

    private var bubbleShape: ChatBubbleShape {
        // SwiftUI already mirrors Shape paths in RTL on the supported OS versions.
        ChatBubbleShape(
            cornerRadius: ChatUIConstants.bubbleCorner,
            tail: self.usesTail ? (self.isUser ? .right : .left) : .none,
            cornerTail: self.style != .onboarding)
    }

    /// Without an avatar beside it, the tail is what says whose bubble it is.
    private var usesTail: Bool {
        #if os(iOS)
        self.style == .onboarding || !self.showsAssistantAvatar
        #else
        self.style == .onboarding
        #endif
    }

    /// The tail is drawn inside the bubble's frame; keep the text clear of it.
    private var tailInset: CGFloat {
        self.usesTail && self.style != .onboarding ? ChatBubbleShape.cornerTailWidth : 0
    }

    private var tailPaddingLeading: CGFloat {
        self.style == .onboarding && !self.isUser ? 8 : 0
    }

    private var tailPaddingTrailing: CGFloat {
        self.style == .onboarding && self.isUser ? 8 : 0
    }
}

private struct AttachmentRow: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout

    let att: OpenClawChatMessageContent
    let isUser: Bool
    let textColor: Color
    let resolverReady: Bool
    let playbackAllowed: @MainActor @Sendable () -> Bool
    let loadMedia: @MainActor @Sendable (
        String,
        OpenClawChatMediaKind,
        OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?

    var body: some View {
        if let artifactId = self.fetchableArtifactId, let kind = self.att.mediaKind {
            switch kind {
            case .file:
                ChatFileAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    fileName: self.att.fileName ?? self.attachmentLabel,
                    resolverReady: self.resolverReady,
                    load: { try await self.loadMedia($0, .file, nil) })
            case .image:
                ChatMediaImageAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    resolverReady: self.resolverReady,
                    load: { try await self.loadMedia($0, .image, nil) })
            case .audio:
                ChatMediaAudioAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    durationSeconds: self.att.durationSeconds,
                    resolverReady: self.resolverReady,
                    playbackAllowed: self.playbackAllowed,
                    load: { try await self.loadMedia($0, .audio, self.att.playback) })
            case .video:
                ChatMediaVideoAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    width: self.att.width,
                    height: self.att.height,
                    resolverReady: self.resolverReady,
                    playbackAllowed: self.playbackAllowed,
                    load: { try await self.loadMedia($0, .video, self.att.playback) })
            }
        } else {
            self.fallbackRow
        }
    }

    private var fallbackRow: some View {
        HStack(spacing: 8) {
            Image(systemName: OpenClawChatPickerAttachmentMetadata.fileIcon(
                mimeType: self.att.mimeType ?? "",
                fileName: self.att.fileName ?? ""))
            VStack(alignment: .leading, spacing: 2) {
                Text(self.isAudio && self.att.durationSeconds != nil && self.att.url == nil
                    ? String(localized: "Voice note") : self.attachmentLabel)
                    .font(OpenClawChatTypography.footnote)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(self.textColor)
                if let sizeBytes = self.att.sizeBytes {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(sizeBytes), countStyle: .file))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(self.textColor.opacity(self.isDesktopLayout ? 0.9 : 0.72))
                }
            }
            if self.isAudio, let durationSeconds = self.att.durationSeconds {
                Text(openClawVoiceNoteDurationLabel(durationSeconds))
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(self.textColor.opacity(self.isDesktopLayout ? 0.9 : 0.72))
            }
            Spacer()
        }
        .padding(10)
        .background(self.isUser
            ? Color.white.opacity(self.isDesktopLayout ? 0.04 : 0.2)
            : Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var isAudio: Bool {
        self.att.mediaKind == .audio
    }

    private var fetchableArtifactId: String? {
        guard let kind = self.att.mediaKind else { return nil }
        let value = self.att.artifactId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !value.isEmpty && kind.acceptsManagedArtifactID(value) ? value : nil
    }

    private var attachmentLabel: String {
        let values = [self.att.alt, self.att.fileName]
        return values.lazy
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? String(localized: "Attachment")
    }
}

@MainActor
struct ChatTypingIndicatorBubble: View {
    let style: OpenClawChatView.Style
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool
    let runIdentity: String
    let outputTokens: Int?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if self.showsAssistantAvatar {
                ChatAgentAvatar(
                    text: self.assistantAvatarText,
                    name: self.assistantName,
                    tint: self.assistantAvatarTint,
                    size: 28)
            }

            HStack(spacing: 9) {
                ChatWorkingIndicatorContent(
                    runIdentity: self.runIdentity,
                    outputTokens: self.outputTokens)
                    .id(self.runIdentity)
            }
            .padding(.vertical, self.isClean ? 5 : (self.style == .standard ? 10 : 9))
            .padding(.horizontal, self.isClean ? 4 : (self.style == .standard ? 12 : 14))
            .assistantBubbleContainerStyle(isClean: self.isClean, cornerRadius: 15)
            .fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .focusable(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            Text("Writing")
                .font(OpenClawChatTypography.caption))
    }
}

private struct ChatWorkingIndicatorContent: View {
    @State private var startedAt: Date
    let seed: String
    let outputTokens: Int?

    init(runIdentity: String, outputTokens: Int?) {
        _startedAt = State(initialValue: Date())
        self.seed = runIdentity
        self.outputTokens = outputTokens
    }

    var body: some View {
        HStack(spacing: 9) {
            ChatWorkingClawView(seed: self.seed)
            ChatWorkingStatusText(
                startedAt: self.startedAt,
                seed: self.seed,
                outputTokens: self.outputTokens)
        }
    }
}

/// Inline playback state under an assistant bubble while Listen is active;
/// tapping it stops speech.
struct ChatSpeechStatusChip: View {
    let isPreparing: Bool
    let onStop: () -> Void

    var body: some View {
        Button(action: self.onStop) {
            HStack(spacing: 4) {
                Image(systemName: self.isPreparing ? "hourglass" : "speaker.wave.2.fill")
                    .font(.system(size: 10, weight: .semibold))
                if self.isPreparing {
                    Text("Preparing audio…")
                        .font(OpenClawChatTypography.caption)
                } else {
                    Text("Speaking…")
                        .font(OpenClawChatTypography.caption)
                }
            }
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.isPreparing
            ? "Preparing audio, tap to cancel"
            : "Speaking, tap to stop")
    }
}

/// Status footer for a user bubble backed by the durable offline outbox.
@MainActor
struct ChatOutboxStatusLabel: View {
    let state: OpenClawChatOutboxMessageState

    var body: some View {
        let presentation = self.presentation
        HStack(spacing: 4) {
            Image(systemName: presentation.iconName)
                .font(.system(size: 10, weight: .semibold))
            Text(presentation.title)
                .font(OpenClawChatTypography.caption)
        }
        .foregroundStyle(self.state.isFailed ? AnyShapeStyle(OpenClawChatTheme.danger) : AnyShapeStyle(.secondary))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            Text(presentation.accessibilityText)
                .font(OpenClawChatTypography.caption))
    }

    private var presentation: (
        title: LocalizedStringResource,
        iconName: String,
        accessibilityText: LocalizedStringResource)
    {
        switch self.state {
        case .queued:
            ("Queued", "clock", "Queued, sends when reconnected")
        case .sending:
            ("Sending…", "arrow.up.circle", "Sending")
        case .confirming:
            ("Confirming…", "checkmark.circle", "Sent, waiting for chat history confirmation")
        case let .failed(reason) where reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError:
            ("Delivery unknown", "questionmark.circle", "Delivery unconfirmed, touch and hold to retry or delete")
        case .failed:
            ("Not sent", "exclamationmark.circle", "Not sent, touch and hold to retry or delete")
        }
    }
}

extension ChatTypingIndicatorBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.style == rhs.style &&
            lhs.assistantName == rhs.assistantName &&
            lhs.assistantAvatarText == rhs.assistantAvatarText &&
            lhs.assistantAvatarTint == rhs.assistantAvatarTint &&
            lhs.showsAssistantAvatar == rhs.showsAssistantAvatar &&
            lhs.isClean == rhs.isClean &&
            lhs.runIdentity == rhs.runIdentity &&
            lhs.outputTokens == rhs.outputTokens
    }
}

// Keep this explicit for SwiftPM toolchains where SwiftUI macro plugins are unavailable.
// swiftformat:disable environmentEntry
private struct OpenClawAssistantUsesReadingColumnKey: EnvironmentKey {
    static let defaultValue = false
}

private struct OpenClawAssistantBubblesInCleanChromeKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The chat column owns tablet width for both streaming and completed answers.
    var openClawAssistantUsesReadingColumn: Bool {
        get { self[OpenClawAssistantUsesReadingColumnKey.self] }
        set { self[OpenClawAssistantUsesReadingColumnKey.self] = newValue }
    }

    /// Clients that want iMessage-style assistant bubbles in the clean chrome
    /// (the iOS app) opt in; the default keeps the plain clean look elsewhere.
    public var openClawAssistantBubblesInCleanChrome: Bool {
        get { self[OpenClawAssistantBubblesInCleanChromeKey.self] }
        set { self[OpenClawAssistantBubblesInCleanChromeKey.self] = newValue }
    }
}

// swiftformat:enable environmentEntry

private struct AssistantBubbleContainerStyle: ViewModifier {
    let isClean: Bool
    let cornerRadius: CGFloat

    @Environment(\.openClawAssistantBubblesInCleanChrome) private var bubblesInClean
    @Environment(\.openClawAssistantUsesReadingColumn) private var usesReadingColumn

    func body(content: Content) -> some View {
        Group {
            if self.isClean, !self.bubblesInClean {
                content
            } else {
                content
                    // Clean call sites pre-pad only ~4pt; bubbles need room to breathe.
                        .padding(self.isClean ? 8 : 0)
                        .background(
                            RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                                .fill(OpenClawChatTheme.assistantBubble))
                        .overlay(
                            RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            }
        }
        .frame(maxWidth: self.usesReadingColumn ? .infinity : ChatUIConstants.bubbleMaxWidth, alignment: .leading)
    }
}

extension View {
    func assistantBubbleContainerStyle(isClean: Bool, cornerRadius: CGFloat = 16) -> some View {
        modifier(AssistantBubbleContainerStyle(isClean: isClean, cornerRadius: cornerRadius))
            .focusable(false)
    }
}

/// Defers action construction until SwiftUI evaluates this body, instead of eagerly assembling actions
/// in every parent-row update. SwiftUI owns when menu content is evaluated.
struct ChatDeferredContent<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        self.content()
    }
}

struct ChatStreamingAssistantText {
    let sourceText: String
    let includesThinking: Bool
    let segments: [AssistantTextSegment]

    init(sourceText: String, includesThinking: Bool) {
        self.sourceText = sourceText
        self.includesThinking = includesThinking
        self.segments = AssistantTextParser.segments(from: sourceText, includeThinking: includesThinking)
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    let text: ChatStreamingAssistantText
    let markdownVariant: ChatMarkdownVariant
    let assistantName: String?
    let assistantAvatarText: String?
    let assistantAvatarTint: Color?
    let showsAssistantAvatar: Bool
    let isClean: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if self.showsAssistantAvatar {
                ChatAgentAvatar(
                    text: self.assistantAvatarText,
                    name: self.assistantName,
                    tint: self.assistantAvatarTint)
                    .padding(.top, 1)
            }

            VStack(alignment: .leading, spacing: 10) {
                ChatStreamingAssistantTextBody(
                    text: self.text,
                    markdownVariant: self.markdownVariant,
                    textColor: self.isDesktopLayout
                        ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
                        : OpenClawChatTheme.assistantText)
            }
            .padding(self.isClean ? 4 : 12)
            .assistantBubbleContainerStyle(isClean: self.isClean)
            .contentShape(.accessibility, Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-streaming-assistant-body")
            .assistantSpeakerLabel(
                self.assistantName,
                avatarHidden: !self.showsAssistantAvatar)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ChatStreamingAssistantBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text.sourceText == rhs.text.sourceText &&
            lhs.text.includesThinking == rhs.text.includesThinking &&
            lhs.markdownVariant == rhs.markdownVariant &&
            lhs.assistantName == rhs.assistantName &&
            lhs.assistantAvatarText == rhs.assistantAvatarText &&
            lhs.assistantAvatarTint == rhs.assistantAvatarTint &&
            lhs.showsAssistantAvatar == rhs.showsAssistantAvatar &&
            lhs.isClean == rhs.isClean
    }
}

extension AssistantTextSegment.Kind {
    var markdownTypography: ChatMarkdownRenderer.Typography {
        switch self {
        case .response: .response
        case .thinking: .thinking
        }
    }
}

private struct ChatAssistantTextBody: View {
    let text: String
    let markdownVariant: ChatMarkdownVariant
    let includesThinking: Bool
    let textColor: Color

    var body: some View {
        let segments = AssistantTextParser.segments(from: self.text, includeThinking: self.includesThinking)
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                ChatMarkdownRenderer(
                    text: segment.text,
                    context: .assistant,
                    variant: self.markdownVariant,
                    typography: segment.kind.markdownTypography,
                    textColor: self.textColor,
                    isComplete: true)
            }
        }
    }
}

@MainActor
private struct ChatStreamingAssistantTextBody: View {
    private let inputSnapshot: Snapshot
    let markdownVariant: ChatMarkdownVariant
    let textColor: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var snapshot: Snapshot
    @State private var revealState: ChatStreamingRevealState
    @State private var revealLocation: Snapshot.ProseLocation?
    @State private var pendingUntil: TimeInterval?

    init(text: ChatStreamingAssistantText, markdownVariant: ChatMarkdownVariant, textColor: Color) {
        self.markdownVariant = markdownVariant
        self.textColor = textColor

        let now = Date.timeIntervalSinceReferenceDate
        let snapshot = Snapshot(text: text)
        // State retains its old value across updates. Reuse this prepared input
        // when applying the delta instead of parsing the same Markdown again.
        self.inputSnapshot = snapshot
        let location = snapshot.lastProseLocation
        let revealState = location.map {
            step(state: ChatStreamingRevealState(), newText: snapshot.prose(at: $0).plainText, now: now)
        } ?? ChatStreamingRevealState()
        self._snapshot = State(initialValue: snapshot)
        self._revealState = State(initialValue: revealState)
        self._revealLocation = State(initialValue: location)
        self._pendingUntil = State(initialValue: revealState.latestDeadline)
    }

    var body: some View {
        Group {
            if self.reduceMotion || self.pendingUntil == nil {
                self.render(now: nil)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
                    self.render(now: timeline.date.timeIntervalSinceReferenceDate)
                }
            }
        }
        .onChange(of: self.inputSnapshot.sourceText) { _, _ in
            self.updateSnapshot()
        }
        .onChange(of: self.inputSnapshot.includesThinking) { _, _ in
            self.updateSnapshot()
        }
        .onChange(of: self.reduceMotion) { _, reduceMotion in
            self.pendingUntil = reduceMotion ? nil : self.futureDeadline()
        }
        .onAppear {
            if self.snapshot.sourceText != self.inputSnapshot.sourceText ||
                self.snapshot.includesThinking != self.inputSnapshot.includesThinking
            {
                self.updateSnapshot()
            }
        }
        .task(id: self.pendingUntil) {
            guard let pendingUntil = self.pendingUntil else { return }
            let delay = max(0, pendingUntil - Date.timeIntervalSinceReferenceDate)
            if delay > 0 {
                try? await Task.sleep(for: .seconds(delay))
            }
            guard !Task.isCancelled, self.pendingUntil == pendingUntil else { return }
            self.pendingUntil = nil
        }
    }

    private func render(now: TimeInterval?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(self.snapshot.segments.enumerated()), id: \.offset) { entry in
                let segment = entry.element
                let reveal = self.reveal(
                    segmentIndex: entry.offset,
                    now: now)
                ChatMarkdownRenderer(
                    snapshot: segment.markdown,
                    context: .assistant,
                    variant: self.markdownVariant,
                    typography: segment.kind.markdownTypography,
                    textColor: self.textColor,
                    reveal: reveal)
            }
        }
    }

    private func reveal(segmentIndex: Int, now: TimeInterval?) -> ChatMarkdownProseReveal? {
        guard let now,
              let location = self.revealLocation,
              location.segmentIndex == segmentIndex
        else { return nil }
        return ChatMarkdownProseReveal(
            blockIndex: location.blockIndex,
            state: self.revealState,
            now: now)
    }

    private func updateSnapshot() {
        let now = Date.timeIntervalSinceReferenceDate
        let nextSnapshot = self.inputSnapshot
        let nextLocation = nextSnapshot.lastProseLocation
        let nextRevealState = nextLocation.map { location in
            step(
                state: location == self.revealLocation ? self.revealState : ChatStreamingRevealState(),
                newText: nextSnapshot.prose(at: location).plainText,
                now: now)
        } ?? ChatStreamingRevealState()

        self.snapshot = nextSnapshot
        self.revealLocation = nextLocation
        self.revealState = nextRevealState
        self.pendingUntil = self.reduceMotion ? nil : self.futureDeadline(now: now, state: nextRevealState)
    }

    private func futureDeadline(
        now: TimeInterval = Date.timeIntervalSinceReferenceDate,
        state: ChatStreamingRevealState? = nil) -> TimeInterval?
    {
        guard let deadline = (state ?? self.revealState).latestDeadline, deadline > now else {
            return nil
        }
        return deadline
    }

    @MainActor
    private struct Snapshot {
        struct Segment {
            let kind: AssistantTextSegment.Kind
            let markdown: ChatMarkdownRenderSnapshot
        }

        struct ProseLocation: Equatable {
            let segmentIndex: Int
            let blockIndex: Int
        }

        let segments: [Segment]
        let lastProseLocation: ProseLocation?
        let sourceText: String
        let includesThinking: Bool

        init(text: ChatStreamingAssistantText) {
            let segments = text.segments.map {
                Segment(
                    kind: $0.kind,
                    markdown: ChatMarkdownRenderSnapshot(
                        text: $0.text,
                        isComplete: false,
                        preparesReveal: true))
            }
            self.segments = segments
            self.sourceText = text.sourceText
            self.includesThinking = text.includesThinking
            self.lastProseLocation = segments.indices.reversed().compactMap { segmentIndex in
                segments[segmentIndex].markdown.lastProseIndex.map {
                    ProseLocation(segmentIndex: segmentIndex, blockIndex: $0)
                }
            }.first
        }

        func prose(at location: ProseLocation) -> ChatMarkdownProse {
            guard case let .prose(prose) = self.segments[location.segmentIndex]
                .markdown.blocks[location.blockIndex]
            else {
                preconditionFailure("Streaming reveal location must identify prose")
            }
            return prose
        }
    }
}

extension View {
    /// Without an avatar beside it, the reply's own container names the assistant for VoiceOver.
    /// The label is empty where the avatar is shown, so a size-class change keeps the view's identity.
    func assistantSpeakerLabel(_ name: String?, avatarHidden: Bool) -> some View {
        self.accessibilityLabel(Text(verbatim: avatarHidden ? name ?? "" : ""))
    }
}
