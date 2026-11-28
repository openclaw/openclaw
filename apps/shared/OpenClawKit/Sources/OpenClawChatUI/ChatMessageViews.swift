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
            #if os(iOS)
            // Inside the iOS List a default DisclosureGroup turns into an outline row that the
            // label tap does not toggle; keep the inline label + chevron behaviour.
            .disclosureGroupStyle(ChatInlineDisclosureStyle())
            #endif
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

#if os(iOS)
/// The one disclosure for transcript rows inside the iOS List: a fixed header (label + rotating
/// chevron, 44 pt target) that never moves, with content easing in below it. A default
/// DisclosureGroup there turns into an outline row that the label tap does not toggle.
struct ChatInlineDisclosureStyle: DisclosureGroupStyle {
    enum Chevron {
        case tint
        case secondary
    }

    var chevron: Chevron = .tint

    func makeBody(configuration: Configuration) -> some View {
        ChatInlineDisclosure(configuration: configuration, chevron: self.chevron)
    }
}

private struct ChatInlineDisclosure: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openClawReadingPosition) private var readingPosition
    let configuration: DisclosureGroupStyleConfiguration
    let chevron: ChatInlineDisclosureStyle.Chevron

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                // The state changes inside the transaction, so the List row resizes with it and the
                // rows below slide instead of snapping. The reading position holds this header still.
                let animation: Animation = self.reduceMotion ? .easeInOut(duration: 0.2) : .snappy(duration: 0.25)
                let readingPosition = self.readingPosition
                readingPosition?.disclosureWillToggle()
                ChatScrollSignpost.disclosureToggle(animation) {
                    self.configuration.isExpanded.toggle()
                } completion: {
                    readingPosition?.disclosureDidSettle()
                }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    self.configuration.label
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(self.chevronStyle)
                        .rotationEffect(.degrees(self.configuration.isExpanded ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(self.configuration.isExpanded ? Text("Expanded") : Text("Collapsed"))
            // Content enters below the header only; the clip keeps it from sliding over the header.
            VStack(alignment: .leading, spacing: 0) {
                if self.configuration.isExpanded {
                    self.configuration.content
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .transition(self.reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .clipped()
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private var chevronStyle: AnyShapeStyle {
        switch self.chevron {
        case .tint: AnyShapeStyle(.tint)
        case .secondary: AnyShapeStyle(.secondary)
        }
    }
}
#endif

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
    #if os(iOS)
    static let bubbleCorner: CGFloat = 16
    static let userFooterSpacing: CGFloat = 4
    /// How far a reactions pill reaches into the user bubble. Less than the bubble's 14-point
    /// leading padding, so it never covers text.
    static let reactionOverlap: CGFloat = 8
    /// A user's attachments sit above the bubble, outside it, as in the Control UI: images 8 pt
    /// above the text (`--space-2`, ui/src/styles/chat/text.css:1578-1584), any other block one
    /// block gap away (`--chat-block-gap`, 14 px at the default size; text.css:1548-1575,
    /// base.css:311 and 322).
    static let userMediaToTextSpacing: CGFloat = 8
    static let userBlockSpacing: CGFloat = 14
    /// Several images become square tiles, three to a row (two for two or four images), 4 pt apart,
    /// at most 128 pt: `--chat-user-image-grid-size` in ui/src/styles/chat/message-layout.css:563-603.
    static let userImageTileMax: CGFloat = 128
    static let userImageTileGap: CGFloat = 4
    #else
    /// Web `--radius-md` (ui/src/styles/base.css:366) on the user bubble.
    static let bubbleCorner: CGFloat = 10
    #endif
    static let onboardingBubbleCorner: CGFloat = 18

    /// The images past the four a message shows.
    static func imagesNotShown(_ count: Int) -> String {
        count == 1 ? String(localized: "1 more image not shown")
            : String(format: String(localized: "%lld more images not shown"), Int64(count))
    }
}

#if os(iOS)
extension ChatColumnLayout {
    /// A gallery tile: three tiles and their gaps fit the user bubble's measure, at most 128 pt.
    var userImageTileSide: CGFloat {
        let gap = ChatUIConstants.userImageTileGap
        return min(ChatUIConstants.userImageTileMax, ((self.bubbleAndMediaMaxWidth - 2 * gap) / 3).rounded(.down))
    }
}

/// What the transcript attaches to a user bubble: its long-press menu and its reactions pill.
struct ChatUserBubbleAccessories {
    let menu: () -> AnyView
    let reactions: () -> AnyView
}

/// The user bubble's long-press menu and reactions pill. The pill hangs on the bubble's lower-left
/// corner: it reaches `reactionOverlap` into the bubble and grows outward without moving the next message. Beside a
/// bubble as
/// wide as the column it grows inward instead. The menu lifts the bubble and its pill as one shape,
/// like Messages lifts a bubble with its tapback: never the entire row.
private struct ChatUserBubbleDecorations<Bubble: View>: View {
    @Environment(\.openClawChatColumn) private var column
    let bubble: Bubble
    let shape: ChatBubbleShape
    let accessories: ChatUserBubbleAccessories
    @State private var bubbleWidth: CGFloat = 0
    @State private var pill: CGSize = .zero

    var body: some View {
        let reach = self.pill == .zero ? 0
            : min(self.pill.width - ChatUIConstants.reactionOverlap, max(0, self.column.columnWidth - self.bubbleWidth))
        let drop = self.pill == .zero ? 0 : ChatUIConstants.userFooterSpacing
        // Pad the bubble's frame out to the pill so the menu's preview holds all of it, then take the
        // padding back so the layout stays the bubble's alone.
        self.bubble
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { self.bubbleWidth = $0 }
            .padding(.leading, reach)
            .padding(.bottom, drop)
            .overlay(alignment: .bottomLeading) {
                self.accessories.reactions()
                    .environment(\.openClawReactionPillOnUserBubble, true)
                    .fixedSize()
                    .onGeometryChange(for: CGSize.self, of: \.size) { self.pill = $0 }
            }
            .contentShape(
                .contextMenuPreview,
                ChatBubbleWithReactionsShape(bubble: self.shape, reach: reach, drop: drop, pill: self.pill))
            .chatActionContextMenu { self.accessories.menu() }
            .padding(.leading, -reach)
            .padding(.bottom, -drop)
    }
}

private struct ChatBubbleWithReactionsShape: Shape {
    let bubble: ChatBubbleShape
    let reach: CGFloat
    let drop: CGFloat
    let pill: CGSize

    func path(in rect: CGRect) -> Path {
        let bubble = self.bubble.path(in: CGRect(
            x: rect.minX + self.reach,
            y: rect.minY,
            width: rect.width - self.reach,
            height: rect.height - self.drop))
        guard self.pill != .zero else { return bubble }
        return bubble.union(Capsule().path(in: CGRect(
            x: rect.minX,
            y: rect.maxY - self.pill.height,
            width: self.pill.width,
            height: self.pill.height)))
    }
}
#endif

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

/// The transcript's assistant avatar. It reads the identity itself, so a name or emoji that
/// arrives from the Gateway redraws the avatars and not the rows around them.
struct ChatAssistantAvatar: View {
    @Environment(\.openClawAssistantIdentity) private var identity
    var size: CGFloat = 30

    var body: some View {
        ChatAgentAvatar(
            text: self.identity.avatarText,
            name: self.identity.name,
            tint: self.identity.avatarTint,
            size: self.size)
    }
}

/// How the transcript names and draws the assistant. Only `ChatAssistantAvatar` and the speaker
/// label read it; rows never take it as an input.
struct ChatAssistantIdentity: Equatable {
    var name: String?
    var avatarText: String?
    var avatarTint: Color?
}

extension EnvironmentValues {
    @Entry var openClawAssistantIdentity = ChatAssistantIdentity()
    @Entry var openClawChatUserAccent: Color?
    @Entry var openClawChatGateway: ChatGatewayResources?
}

/// Gateway state and loaders that only media, widget and source-favicon leaves use. Rows reach it
/// through the environment, so a health flip or a source-context refresh updates those leaves and
/// never changes a row's inputs. Equal per owner: the getters read observable state when a leaf
/// calls them from its body, so each leaf observes only what it reads.
struct ChatGatewayResources: Equatable {
    let owner: ObjectIdentifier
    /// Media artifacts and widget resources resolve only over a healthy connection.
    let isResolverReady: @MainActor () -> Bool
    /// The source context while it allows favicon fetches; favicon loads restart when it changes.
    let faviconContext: @MainActor () -> OpenClawChatSourceContext?
    let loadFavicon: @MainActor @Sendable (String) async -> Data?
    let resolveWidgetResource: @MainActor @Sendable (
        String,
        OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    let loadMedia: @MainActor @Sendable (
        String,
        OpenClawChatMediaKind,
        OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.owner == rhs.owner
    }
}

/// Reads the accent itself, so a Gateway accent change repaints user bubbles without re-running them.
private struct ChatUserBubbleSurface: View {
    @Environment(\.openClawChatUserAccent) private var accent
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        OpenClawChatTheme.userBubbleSurface(in: self.colorScheme, accent: self.accent)
    }
}

/// The user bubble; the onboarding style adds a sender tail on the trailing edge.
private struct ChatBubbleShape: InsettableShape {
    let cornerRadius: CGFloat
    var hasTail = false
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
        return self.hasTail
            ? self.tailPath(in: rect, radius: self.cornerRadius)
            : Path(roundedRect: rect, cornerRadius: self.cornerRadius, style: .continuous)
    }

    private func tailPath(in rect: CGRect, radius r: CGFloat) -> Path {
        let bubbleMinX = rect.minX
        let bubbleMaxX = rect.maxX - self.tailWidth
        let bubbleMinY = rect.minY
        let bubbleMaxY = rect.maxY
        let available = max(4, bubbleMaxY - bubbleMinY - 2 * r)
        let baseH = min(self.tailBaseHeight, available)
        let baseBottomY = bubbleMaxY - max(r * 0.45, 6)
        let baseTopY = baseBottomY - baseH
        let midY = (baseTopY + baseBottomY) / 2

        var path = Path()
        path.move(to: CGPoint(x: bubbleMinX + r, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX - r, y: bubbleMinY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX, y: bubbleMinY + r),
            control: CGPoint(x: bubbleMaxX, y: bubbleMinY))
        path.addLine(to: CGPoint(x: bubbleMaxX, y: baseTopY))
        path.addCurve(
            to: CGPoint(x: bubbleMaxX + self.tailWidth, y: midY),
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseTopY + baseH * 0.05),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY - baseH * 0.15))
        path.addCurve(
            to: CGPoint(x: bubbleMaxX, y: baseBottomY),
            control1: CGPoint(x: bubbleMaxX + self.tailWidth * 0.95, y: midY + baseH * 0.15),
            control2: CGPoint(x: bubbleMaxX + self.tailWidth * 0.2, y: baseBottomY - baseH * 0.05))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMaxX - r, y: bubbleMaxY),
            control: CGPoint(x: bubbleMaxX, y: bubbleMaxY))
        path.addLine(to: CGPoint(x: bubbleMinX + r, y: bubbleMaxY))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX, y: bubbleMaxY - r),
            control: CGPoint(x: bubbleMinX, y: bubbleMaxY))
        path.addLine(to: CGPoint(x: bubbleMinX, y: bubbleMinY + r))
        path.addQuadCurve(
            to: CGPoint(x: bubbleMinX + r, y: bubbleMinY),
            control: CGPoint(x: bubbleMinX, y: bubbleMinY))
        return path
    }
}

@MainActor
struct ChatMessageBubble: View, @MainActor Equatable {
    @Environment(\.openClawChatColumn) private var column
    @Environment(\.openClawAssistantRunContent) private var isRunContent
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    let message: OpenClawChatMessage
    var liveToolCalls: [OpenClawChatPendingToolCall] = []
    var metadata: ChatMessageMetadata?
    var sourcePreviews: [ChatSourcePreview] = []
    let style: OpenClawChatView.Style
    let markdownVariant: ChatMarkdownVariant
    let displayOptions: OpenClawChatDisplayOptions
    let showsAssistantAvatar: Bool
    let contextWindowTokens: Int?
    let userMessageExpanded: Bool
    let onToggleUserMessageExpanded: @MainActor () -> Void
    let inlineWidgetScope: ChatInlineWidgetScope
    let mediaPlaybackAllowed: @MainActor @Sendable () -> Bool
    #if os(iOS)
    /// Not compared: only user bubbles carry it, and the iOS render gate never holds those.
    var userBubbleAccessories: ChatUserBubbleAccessories?
    #endif

    var canUseIOSRenderGate: Bool {
        guard self.message.role.lowercased() == "assistant" else { return false }
        return !self.message.content.contains { content in
            content.isInlineAttachment || (content.type ?? "").lowercased() == "canvas"
        }
    }

    /// Row content only. Gateway state (resolver readiness, the source context, the assistant's
    /// identity, the user accent) reaches the leaves that draw it through the environment.
    static func == (lhs: Self, rhs: Self) -> Bool {
        // The iOS gate excludes media rows, so `mediaPlaybackAllowed` cannot affect its subtree.
        // Comparing closure identity would defeat the gate because ChatView rebuilds them each pass.
        guard self.styleValue(lhs.style) == self.styleValue(rhs.style) else { return false }
        return lhs.message == rhs.message &&
            lhs.liveToolCalls == rhs.liveToolCalls &&
            lhs.metadata == rhs.metadata &&
            lhs.sourcePreviews == rhs.sourcePreviews &&
            lhs.markdownVariant.rawValue == rhs.markdownVariant.rawValue &&
            lhs.displayOptions.rawValue == rhs.displayOptions.rawValue &&
            lhs.showsAssistantAvatar == rhs.showsAssistantAvatar &&
            lhs.contextWindowTokens == rhs.contextWindowTokens &&
            lhs.userMessageExpanded == rhs.userMessageExpanded &&
            lhs.inlineWidgetScope == rhs.inlineWidgetScope
    }

    private static func styleValue(_ style: OpenClawChatView.Style) -> UInt8 {
        switch style {
        case .standard: 0
        case .onboarding: 1
        }
    }

    var body: some View {
        // View builders reject `_ = …`; `let _` is the only statement form they accept.
        // swiftlint:disable:next redundant_discardable_let
        let _ = ChatBehaviorProbe.countBody("bubble")
        if self.isUser {
            self.messageBody
                .contentShape(.accessibility, Rectangle())
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-user-message-body")
                #if !os(iOS)
                // On iOS the text bubble and attachments are measured separately.
                .frame(maxWidth: self.column.bubbleAndMediaMaxWidth, alignment: .trailing)
                #endif
                .frame(maxWidth: .infinity, alignment: .trailing)
        } else {
            // Replies span the reading column; only the avatar gutter (wide panes) narrows them.
            HStack(alignment: .top, spacing: 8) {
                if self.showsAssistantAvatar, !self.isRunContent {
                    ChatAssistantAvatar()
                        .padding(.top, 1)
                }

                Group {
                    let content = self.messageBody
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if self.message.isNestedToolActivity {
                        content
                    } else {
                        content.contentShape(.accessibility, Rectangle())
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("chat-assistant-message-body")
                .assistantSpeakerLabel(
                    avatarHidden: !self.showsAssistantAvatar && !self.isRunContent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
            let character = text[index]
            guard character == "\n" || character == "\r\n" else { continue }
            if lineCount == Self.collapsedLineLimit {
                end = index
                break
            }
            lineCount += 1
        }
        guard end < text.endIndex else { return nil }
        return String(text[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
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

/// Resolve the last rendered text line, including text nested in a Markdown quote.
private struct ChatPreviewTailFade: ViewModifier {
    let isCollapsed: Bool

    func body(content: Content) -> some View {
        if self.isCollapsed {
            content.overlayPreferenceValue(Text.LayoutKey.self) { layouts in
                if let tail = layouts.last, let line = tail.layout.last {
                    GeometryReader { proxy in
                        let origin = proxy[tail.origin]
                        Canvas { context, _ in
                            context.translateBy(x: origin.x, y: origin.y)
                            let bounds = line.typographicBounds.rect
                            let rtl = line.first?.layoutDirection == .rightToLeft
                            let end = rtl ? bounds.minX : bounds.maxX
                            let length = min(bounds.width / 2, bounds.height * 3)
                            // Erase ink, not the quote bar or the space between glyphs.
                            context.clipToLayer { ink in
                                ink.addFilter(.alphaThreshold(min: 0.001, color: .white))
                                ink.draw(line)
                            }
                            context.fill(Path(bounds), with: .linearGradient(
                                Gradient(colors: [.clear, .white]),
                                startPoint: CGPoint(x: rtl ? end + length : end - length, y: bounds.midY),
                                endPoint: CGPoint(x: end, y: bounds.midY)))
                        }
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .blendMode(.destinationOut)
                }
            }
            .compositingGroup()
        } else {
            content
        }
    }
}

extension ChatMessageBubble {
    @ViewBuilder
    private var messageBody: some View {
        let text = self.primaryText
        let textColor = self.textColor
        let shouldRenderBubble = self.shouldRenderBubble
        let toolActivityItems = self.toolActivityItems

        VStack(alignment: .leading, spacing: 6) {
            if shouldRenderBubble {
                if self.isUser {
                    #if os(iOS)
                    let bubbleText = self.userBubbleText(text)
                    let hasBubble = !bubbleText.isEmpty
                    VStack(alignment: .trailing, spacing: ChatUIConstants.userFooterSpacing) {
                        if !self.visibleInlineAttachments.isEmpty {
                            self.userAttachments(hasBubble: hasBubble)
                                .padding(.bottom, hasBubble ? self.userAttachmentsToTextSpacing : 0)
                        }
                        if hasBubble {
                            self.userBubble(text: bubbleText, textColor: textColor)
                                .frame(maxWidth: self.column.bubbleAndMediaMaxWidth, alignment: .trailing)
                        }
                        self.footer
                            .padding(.trailing, self.style == .onboarding ? 8 : 0)
                    }
                    #else
                    self.userBubble(text: text, textColor: textColor)
                    #endif
                } else {
                    // Assistant replies are plain text on the column, like the web chat.
                    self.messageContent(text: text, textColor: textColor)
                        .padding(.vertical, 5)
                }
            }

            if !toolActivityItems.isEmpty {
                ChatToolActivityList(items: toolActivityItems, isNestedToolActivity: self.message.isNestedToolActivity)
            }

            if !shouldRenderBubble {
                self.footer
            }
        }
    }

    private func userBubble(text: String, textColor: Color) -> some View {
        let bubble = self.messageContent(text: text, textColor: textColor)
            .padding(self.bubblePadding)
            .background { ChatUserBubbleSurface() }
            .clipShape(self.bubbleShape)
            .overlay {
                if self.style == .onboarding {
                    // A mitred join keeps the tail's point sharp inside the bubble's bounds.
                    self.bubbleShape.strokeBorder(
                        Color.white.opacity(0.12),
                        style: StrokeStyle(lineWidth: 0.5, lineJoin: .miter))
                }
            }
        #if os(iOS)
        return Group {
            if let accessories = self.userBubbleAccessories {
                ChatUserBubbleDecorations(bubble: bubble, shape: self.bubbleShape, accessories: accessories)
            } else {
                bubble
            }
        }
        .padding(.trailing, self.style == .onboarding ? 8 : 0)
        #else
        return bubble.padding(.trailing, self.style == .onboarding ? 8 : 0)
        #endif
    }

    private var textColor: Color {
        if self.isDesktopLayout {
            return OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
        }
        // The user bubble is a quiet accent tint, so both roles read in the label ink.
        return OpenClawChatTheme.assistantText
    }

    private func messageContent(text: String, textColor: Color) -> some View {
        #if os(iOS)
        // A user's attachments sit above the bubble; the bubble keeps only the text.
        let attachments = self.isUser ? [] : self.visibleInlineAttachments
        let omittedImageAttachmentCount = self.isUser ? 0 : self.omittedImageAttachmentCount
        #else
        let attachments = self.visibleInlineAttachments
        let omittedImageAttachmentCount = self.omittedImageAttachmentCount
        #endif
        return VStack(alignment: .leading, spacing: 10) {
            if self.isUser {
                VStack(alignment: .leading, spacing: 4) {
                    self.userMessageText(text: text, textColor: textColor)
                }
            } else {
                ChatAssistantTextBody(
                    text: text,
                    markdownVariant: self.markdownVariant,
                    includesThinking: self.displayOptions.contains(.reasoning),
                    textColor: textColor)
            }

            if !self.sourcePreviews.isEmpty {
                ChatSourcePreviewsView(sources: self.sourcePreviews)
            }

            #if os(macOS)
            if let previewURL = self.linkPreviewURL {
                ChatLinkPreview(url: previewURL)
            }
            #endif

            if !attachments.isEmpty {
                let imageGallery = ChatImageViewerItem.gallery(in: attachments)
                ForEach(attachments.indices, id: \.self) { idx in
                    AttachmentRow(
                        att: attachments[idx],
                        imageGallery: imageGallery,
                        isUser: self.isUser,
                        textColor: textColor,
                        playbackAllowed: self.mediaPlaybackAllowed)
                }
            }

            if omittedImageAttachmentCount > 0 {
                Text(ChatUIConstants.imagesNotShown(omittedImageAttachmentCount))
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(self.inlineWidgets.indices, id: \.self) { idx in
                ChatInlineWidgetView(preview: self.inlineWidgets[idx])
                    // A retained row must not lend its browser or callbacks to another chat owner.
                        .id(self.inlineWidgetScope)
            }

            #if !os(iOS)
            self.footer
            #endif
        }
        .textSelection(.enabled)
        .foregroundStyle(textColor)
    }

    @ViewBuilder
    private func userMessageText(text: String, textColor: Color) -> some View {
        let preview = ChatUserMessageDisclosurePolicy.collapsedPreview(text)

        // The web clamps the rendered Markdown, so a collapsed prompt keeps its quotes and formatting.
        ChatMarkdownRenderer(
            text: (self.userMessageExpanded ? nil : preview) ?? text,
            context: .user,
            variant: self.markdownVariant,
            typography: .response,
            textColor: textColor)
            .chatMarkdownFileLinks()
            .modifier(ChatPreviewTailFade(isCollapsed: preview != nil && !self.userMessageExpanded))

        if preview != nil {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    self.onToggleUserMessageExpanded()
                }
            } label: {
                // Grow the tap target, not the visible gap or the bubble's bottom inset.
                HStack(spacing: 2) {
                    Text(String(localized: self.userMessageExpanded ? "Show less" : "Show more"))
                    Image(systemName: self.userMessageExpanded ? "chevron.up" : "chevron.down")
                        .imageScale(.small)
                        .fontWeight(.semibold)
                }
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(.secondary)
                .padding(EdgeInsets(top: 18, leading: 0, bottom: 10, trailing: 0))
                .contentShape(Rectangle())
                .padding(EdgeInsets(top: -18, leading: 0, bottom: -10, trailing: 0))
            }
            .buttonStyle(.plain)
            .accessibilityValue(String(
                localized: self.userMessageExpanded ? "Expanded" : "Collapsed"))
            .accessibilityIdentifier("chat-user-message-disclosure-toggle")
        }
    }

    @ViewBuilder
    private var footer: some View {
        let usage = self.usagePresentation
        if self.metadata != nil || usage != nil {
            ChatMessageFooter(metadata: self.metadata, usage: usage)
        }
    }

    private var shouldRenderBubble: Bool {
        guard !self.message.isToolResult else { return false }
        return !self.primaryText.isEmpty ||
            !self.inlineAttachments.isEmpty ||
            !self.inlineWidgets.isEmpty
    }

    private var toolActivityItems: [ChatToolActivityItem] {
        guard self.displayOptions.contains(.toolActivity) else { return [] }
        return ChatToolActivity.items(message: self.message, liveTools: self.liveToolCalls)
    }

    #if os(macOS)
    private var linkPreviewURL: URL? {
        let role = self.message.role.lowercased()
        guard role == "user" || role == "assistant",
              let url = chatFirstPreviewURL(in: self.primaryText),
              role != "assistant" || !self.sourcePreviews.contains(where: { $0.represents(url) })
        else { return nil }
        return url
    }
    #endif

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

    /// Web user bubble geometry (ui/src/styles/chat/startup-layout.css:309-316): 16pt at
    /// desktop widths, tightened on phone columns where every point of line length counts.
    private var bubblePadding: EdgeInsets {
        if self.style == .onboarding {
            return EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
        }
        return self.column.columnWidth < 600
            ? EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14)
            : EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16)
    }

    private var bubbleShape: ChatBubbleShape {
        // SwiftUI already mirrors Shape paths in RTL on the supported OS versions.
        self.style == .onboarding
            ? ChatBubbleShape(cornerRadius: ChatUIConstants.onboardingBubbleCorner, hasTail: true)
            : ChatBubbleShape(cornerRadius: ChatUIConstants.bubbleCorner)
    }
}

#if os(iOS)
/// A user's attachments, above the bubble and outside it, aligned to the trailing edge as in the
/// Control UI at phone width: one image at its own preview size, several as square tiles, other
/// files as cards.
extension ChatMessageBubble {
    /// The bubble's text. An attachment-only send carries the app's wire fallback, which the person
    /// did not write, so it draws no bubble.
    fileprivate func userBubbleText(_ text: String) -> String {
        guard !self.inlineAttachments.isEmpty,
              text.trimmingCharacters(in: .whitespacesAndNewlines) == "See attached."
        else { return text }
        return ""
    }

    fileprivate var userAttachmentsToTextSpacing: CGFloat {
        let last = self.visibleInlineAttachments.contains { !AttachmentRow.rendersImage($0) }
            ? ChatUIConstants.userBlockSpacing
            : ChatUIConstants.userMediaToTextSpacing
        return last - ChatUIConstants.userFooterSpacing
    }

    /// Each part lifts on its own with the message's menu: a press on the attachments lifts them, a
    /// press on the bubble lifts the bubble. Without a bubble, the reactions pill hangs on the
    /// attachments instead.
    @ViewBuilder
    fileprivate func userAttachments(hasBubble: Bool) -> some View {
        let shape = ChatBubbleShape(cornerRadius: ChatUIConstants.bubbleCorner)
        let group = self.userAttachmentGroup
        if let accessories = self.userBubbleAccessories {
            if hasBubble {
                group
                    .contentShape(.contextMenuPreview, shape)
                    .chatActionContextMenu { accessories.menu() }
            } else {
                ChatUserBubbleDecorations(bubble: group, shape: shape, accessories: accessories)
            }
        } else {
            group
        }
    }

    private var userAttachmentGroup: some View {
        let attachments = self.visibleInlineAttachments
        let images = attachments.filter(AttachmentRow.rendersImage)
        let others = attachments.filter { !AttachmentRow.rendersImage($0) }
        return VStack(alignment: .trailing, spacing: ChatUIConstants.userBlockSpacing) {
            if images.count == 1 {
                self.userAttachmentRow(images[0])
            } else if images.count > 1 {
                self.userImageTiles(images)
            }
            ForEach(others.indices, id: \.self) { index in
                self.userAttachmentRow(others[index])
                    .frame(maxWidth: self.column.bubbleAndMediaMaxWidth, alignment: .trailing)
            }
            if self.omittedImageAttachmentCount > 0 {
                Text(ChatUIConstants.imagesNotShown(self.omittedImageAttachmentCount))
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Three tiles to a row, two for two or four images; the last row keeps to the trailing edge.
    /// The rows fit the text bubble's measure, as every attachment above the bubble does.
    private func userImageTiles(_ images: [OpenClawChatMessageContent]) -> some View {
        let gap = ChatUIConstants.userImageTileGap
        let columns = images.count == 2 || images.count == 4 ? 2 : 3
        let side = self.column.userImageTileSide
        let rows = stride(from: 0, to: images.count, by: columns).map {
            Array(images[$0..<min($0 + columns, images.count)])
        }
        return VStack(alignment: .trailing, spacing: gap) {
            ForEach(rows.indices, id: \.self) { row in
                HStack(spacing: gap) {
                    ForEach(rows[row].indices, id: \.self) { index in
                        self.userAttachmentRow(rows[row][index], tileSide: side)
                    }
                }
            }
        }
    }

    private func userAttachmentRow(_ att: OpenClawChatMessageContent, tileSide: CGFloat? = nil) -> some View {
        AttachmentRow(
            att: att,
            imageGallery: ChatImageViewerItem.gallery(in: self.visibleInlineAttachments, sentPhotos: true),
            isUser: true,
            textColor: self.textColor,
            playbackAllowed: self.mediaPlaybackAllowed,
            imageTileSide: tileSide,
            messageAttachments: self.visibleInlineAttachments)
    }
}
#endif

/// The media leaf: it reads resolver readiness from the Gateway resources, so a health flip
/// updates attachments and not the row that holds them.
private struct AttachmentRow: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.openClawChatColumn) private var column
    @Environment(\.openClawChatGateway) private var gateway

    let att: OpenClawChatMessageContent
    let imageGallery: [ChatImageViewerItem]
    let isUser: Bool
    let textColor: Color
    let playbackAllowed: @MainActor @Sendable () -> Bool
    /// A square gallery tile for an image, when a user message carries several.
    var imageTileSide: CGFloat?
    /// A user message's attachments, so the viewer can load any of its sent photos, not only this one.
    var messageAttachments: [OpenClawChatMessageContent] = []

    /// Whether a user's attachment draws as an image (a managed artifact, or a sent photo) rather
    /// than a card.
    static func rendersImage(_ att: OpenClawChatMessageContent) -> Bool {
        #if os(iOS)
        if ChatUserImageSource.isRenderable(att) { return true }
        #endif
        return att.mediaKind == .image && self.fetchableArtifactId(att) != nil
    }

    var body: some View {
        #if os(iOS)
        if self.isUser, let image = ChatUserImageSource(self.att) {
            ChatMediaImageAttachment(
                artifactId: image.loadID,
                // A sent photo's name is the picker's ("photo-1A2B.jpg"), not something to read aloud.
                label: self.nonEmptyAlt ?? String(localized: "Photo"),
                width: self.att.width,
                height: self.att.height,
                tileSide: self.imageTileSide,
                maxWidth: self.column.bubbleAndMediaMaxWidth,
                memoryAlias: image.memoryAlias,
                loadingLabel: String(localized: "Loading photo"),
                resolverReady: image.local != nil || self.gateway?.isResolverReady() == true,
                gallery: self.imageGallery,
                load: { id in
                    if let local = image.local { return .data(local) }
                    return try await self.loadMedia(id, .image, nil)
                },
                viewerLoad: { [messageAttachments] id in
                    // The viewer pages through the message's photos with this one loader. The bytes
                    // the phone holds are the original; otherwise it asks for the upload as is
                    // (`.native`), not the transcript's thumbnail.
                    let page = messageAttachments.first { ChatUserImageSource.pageID($0) == id }
                    let local = page.flatMap(ChatUserImageSource.init)?
                        .local ?? (id == image.loadID ? image.local : nil)
                    if let local { return .data(local) }
                    return try await self.loadMedia(id, .image, .native)
                })
        } else {
            self.gatewayMedia
        }
        #else
        self.gatewayMedia
        #endif
    }

    @ViewBuilder
    private var gatewayMedia: some View {
        if let artifactId = Self.fetchableArtifactId(self.att), let kind = self.att.mediaKind {
            let resolverReady = self.gateway?.isResolverReady() == true
            switch kind {
            case .file:
                ChatFileAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    fileName: self.att.fileName ?? self.attachmentLabel,
                    resolverReady: resolverReady,
                    load: { try await self.loadMedia($0, .file, nil) })
            case .image:
                ChatMediaImageAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    width: self.att.width,
                    height: self.att.height,
                    tileSide: self.imageTileSide,
                    maxWidth: self.column.bubbleAndMediaMaxWidth,
                    resolverReady: resolverReady,
                    gallery: self.imageGallery,
                    load: { try await self.loadMedia($0, .image, nil) })
            case .audio:
                // A busy Gateway inspector can omit playback metadata. Let its
                // playback route inspect on demand rather than assume native support.
                ChatMediaAudioAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    durationSeconds: self.att.durationSeconds,
                    resolverReady: resolverReady,
                    playbackAllowed: self.playbackAllowed,
                    load: { try await self.loadMedia($0, .audio, self.att.playback ?? .transcode) })
            case .video:
                ChatMediaVideoAttachment(
                    artifactId: artifactId,
                    label: self.attachmentLabel,
                    width: self.att.width,
                    height: self.att.height,
                    resolverReady: resolverReady,
                    playbackAllowed: self.playbackAllowed,
                    load: { try await self.loadMedia($0, .video, self.att.playback ?? .transcode) })
            }
        } else {
            self.fallbackRow
        }
    }

    private func loadMedia(
        _ artifactId: String,
        _ kind: OpenClawChatMediaKind,
        _ playback: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard let gateway else { return nil }
        return try await gateway.loadMedia(artifactId, kind, playback)
    }

    private var fallbackRow: some View {
        HStack(spacing: 8) {
            Image(systemName: OpenClawChatPickerAttachmentMetadata.fileIcon(
                mimeType: self.att.mimeType ?? "",
                fileName: self.att.fileName ?? ""))
                .accessibilityHidden(true)
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
        .background(self.fallbackRowSurface)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        // Name and size read as one card.
        .accessibilityElement(children: .combine)
    }

    private var fallbackRowSurface: Color {
        #if os(iOS)
        // A user's cards sit on the canvas above the bubble, in the image placeholder's ink.
        if self.isUser { return OpenClawChatTheme.assistantText.opacity(0.07) }
        #endif
        return self.isUser
            ? Color.white.opacity(self.isDesktopLayout ? 0.04 : 0.2)
            : Color.black.opacity(0.04)
    }

    private var isAudio: Bool {
        self.att.mediaKind == .audio
    }

    private static func fetchableArtifactId(_ att: OpenClawChatMessageContent) -> String? {
        guard let kind = att.mediaKind else { return nil }
        let value = att.artifactId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !value.isEmpty && kind.acceptsManagedArtifactID(value) ? value : nil
    }

    private var nonEmptyAlt: String? {
        let alt = self.att.alt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return alt.isEmpty ? nil : alt
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
    @Environment(\.openClawAssistantRunContent) private var isRunContent
    let showsAssistantAvatar: Bool
    let runIdentity: String
    let outputTokens: Int?
    var status: String?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if self.showsAssistantAvatar, !self.isRunContent {
                ChatAssistantAvatar(size: 28)
            }

            HStack(spacing: 9) {
                ChatWorkingIndicatorContent(
                    runIdentity: self.runIdentity,
                    outputTokens: self.outputTokens,
                    status: self.status)
                    .id(self.runIdentity)
            }
            .padding(.vertical, 5)
            .fixedSize(horizontal: true, vertical: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .focusable(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            Text(verbatim: self.status ?? String(localized: "Writing"))
                .font(OpenClawChatTypography.caption))
    }
}

private struct ChatWorkingIndicatorContent: View {
    @State private var startedAt: Date
    let seed: String
    let outputTokens: Int?

    let status: String?

    init(runIdentity: String, outputTokens: Int?, status: String? = nil) {
        _startedAt = State(initialValue: Date())
        self.seed = runIdentity
        self.outputTokens = outputTokens
        self.status = status
    }

    var body: some View {
        HStack(spacing: 9) {
            ChatWorkingClawView(seed: self.seed)
            ChatWorkingStatusText(
                startedAt: self.startedAt,
                seed: self.seed,
                outputTokens: self.outputTokens,
                status: self.status)
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

/// Status footer for a user bubble awaiting durable delivery or confirmation.
@MainActor
struct ChatOutboxStatusLabel: View {
    let state: OpenClawChatOutboxMessageState
    var queueMode: OpenClawChatQueueMode?

    var body: some View {
        let presentation = self.presentation
        HStack(spacing: 4) {
            Image(systemName: presentation.iconName)
                .font(.system(size: 10, weight: .semibold))
            if let modeTitle {
                Text(modeTitle)
                    .font(OpenClawChatTypography.caption)
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
            }
            Text(presentation.title)
                .font(OpenClawChatTypography.caption)
        }
        .foregroundStyle(self.state.isFailed ? AnyShapeStyle(OpenClawChatTheme.danger) : AnyShapeStyle(.secondary))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            Text(presentation.accessibilityText)
                .font(OpenClawChatTypography.caption))
        .accessibilityValue(Text(self.modeTitle ?? LocalizedStringResource("")))
    }

    private var modeTitle: LocalizedStringResource? {
        switch self.queueMode {
        case .steer: "Steer"
        case .followup: "Queue next"
        case nil: nil
        }
    }

    private var presentation: (
        title: LocalizedStringResource,
        iconName: String,
        accessibilityText: LocalizedStringResource)
    {
        switch self.state {
        case .queued:
            ("Queued", "clock", "Queued, waiting to send")
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
        lhs.showsAssistantAvatar == rhs.showsAssistantAvatar &&
            lhs.runIdentity == rhs.runIdentity &&
            lhs.outputTokens == rhs.outputTokens &&
            lhs.status == rhs.status
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

    /// Item source is already inside a parsed assistant segment; do not interpret
    /// assistant tags again or discard its inherited reasoning typography.
    init(markdown: String, kind: AssistantTextSegment.Kind) {
        self.sourceText = markdown
        self.includesThinking = kind == .thinking
        self.segments = [AssistantTextSegment(id: 0, kind: kind, text: markdown)]
    }
}

@MainActor
struct ChatStreamingAssistantBubble: View {
    @Environment(\.openClawAssistantRunContent) private var isRunContent
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    let text: ChatStreamingAssistantText
    let markdownVariant: ChatMarkdownVariant
    let showsAssistantAvatar: Bool

    var body: some View {
        // swiftlint:disable:next redundant_discardable_let
        let _ = ChatBehaviorProbe.countBody("live")
        HStack(alignment: .top, spacing: 8) {
            if self.showsAssistantAvatar, !self.isRunContent {
                ChatAssistantAvatar()
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
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .focusable(false)
            .contentShape(.accessibility, Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-streaming-assistant-body")
            .assistantSpeakerLabel(avatarHidden: !self.showsAssistantAvatar && !self.isRunContent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension ChatStreamingAssistantBubble: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text.sourceText == rhs.text.sourceText &&
            lhs.text.includesThinking == rhs.text.includesThinking &&
            lhs.markdownVariant == rhs.markdownVariant &&
            lhs.showsAssistantAvatar == rhs.showsAssistantAvatar
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
                    .chatMarkdownFileLinks()
            }
        }
    }
}

@MainActor
struct ChatStreamingAssistantTextBody: View {
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
        // One identity whether or not a reveal is pending: swapping a plain render for a
        // TimelineView rebuilt the subtree, so every streaming list item restarted its reveal.
        let idle = self.reduceMotion || self.pendingUntil == nil
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: idle)) { timeline in
            self.render(now: idle ? nil : timeline.date.timeIntervalSinceReferenceDate)
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
                    .chatMarkdownFileLinks()
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
    func assistantSpeakerLabel(avatarHidden: Bool) -> some View {
        self.modifier(ChatAssistantSpeakerLabel(avatarHidden: avatarHidden))
    }
}

/// Reads the assistant's name itself, so a name change relabels the container without re-running it.
private struct ChatAssistantSpeakerLabel: ViewModifier {
    @Environment(\.openClawAssistantIdentity) private var identity
    let avatarHidden: Bool

    func body(content: Content) -> some View {
        content.accessibilityLabel(Text(verbatim: self.avatarHidden ? self.identity.name ?? "" : ""))
    }
}
