import SwiftUI

#if !os(macOS)
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif
#endif

struct CleanChatComposerSurface: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        self.platformSurface(content)
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
            .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }

    @ViewBuilder
    private func platformSurface(_ content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(self.isDesktopLayout
                        ? AnyShapeStyle(OpenClawChatTheme.desktopComposer(in: self.colorScheme))
                        : OpenClawChatTheme.composerField))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
        }
        #endif
    }
}

enum CleanChatComposerMetrics {
    static let surfaceCornerRadius: CGFloat = 20
    static let controlTouchSize: CGFloat = 44
    static let primaryVisualSize: CGFloat = 32
    #if os(iOS)
    static let footerInk = Color.primary.opacity(0.68)
    /// The gauge needle reads one step stronger than the dial, as in the Control UI.
    static let footerStrongInk = Color.primary.opacity(0.86)
    static let footerOutlineSize: CGFloat = 15
    static let footerOutlineStroke: CGFloat = 1.5
    static let effortGaugeWidth: CGFloat = 17.5
    /// Small glyphs hug their neighbors; the full control height keeps the vertical target.
    static let glyphControlWidth: CGFloat = 36
    /// Open, the primary disc sits 10 pt from the trailing and bottom edges.
    static let expandedControlInset: CGFloat = 4
    /// Open, the 14 pt `+` glyph shares the draft's leading edge.
    static let expandedLeadingControlInset: CGFloat = 0
    /// The space above the first line's capitals equals the space from the last baseline to the top of the
    /// primary disc. Inter's capitals sit in the middle of its line box (ascender minus cap height equals
    /// the descender), so the two spaces stay equal at every text size: inset + ascender − cap height on
    /// top, descender + gap + the disc's inset in its row below.
    static let expandedEditorTopInset: CGFloat = 11
    static let expandedControlsGap: CGFloat = expandedEditorTopInset - (controlTouchSize - primaryVisualSize) / 2
    /// Concentric with the primary disc: its 16 pt radius plus its 10 pt inset.
    static let expandedCornerRadius: CGFloat = 26
    /// Collapsed, the same controls sit concentric with the capsule.
    static let collapsedControlInset: CGFloat = 6
    #endif
    static let editorInlineInset: CGFloat = 14
    static let footerInlineInset: CGFloat = 8
    static let footerBlockInset: CGFloat = 6
    static let rowGap: CGFloat = 4
    static let regularModelMaxWidth: CGFloat = 148
    static let compactModelWidth: CGFloat = controlTouchSize
}

#if !os(macOS)
/// The Control UI effort gauge on the web icon's 24-unit grid: a 240° dial open at the
/// bottom, a filled arc up to the selected level, and a needle from the hub.
struct CleanChatEffortGauge: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Needle angle in degrees, from -120 (lowest level) to 120 (highest).
    let angle: Double
    let fastModeEnabled: Bool
    let accentProgress: Bool
    let width: CGFloat
    let ink: Color
    let needleInk: Color

    var body: some View {
        let unit = self.width / 22
        let stroke = StrokeStyle(lineWidth: 2 * unit, lineCap: .round)
        let fraction = min(max((self.angle + 120) / 240, 0), 1)
        // Fast mode replaces the needle, so the lowest level keeps a dot at the dial's start.
        let progress = fraction > 0 ? fraction : (self.fastModeEnabled ? 0.001 : 0)
        ZStack {
            CleanChatEffortGaugeDial()
                .stroke(self.ink.opacity(0.32), style: stroke)
            CleanChatEffortGaugeDial()
                .trim(from: 0, to: progress)
                .stroke(
                    self.accentProgress
                        ? AnyShapeStyle(LinearGradient(
                            colors: [OpenClawChatTheme.accent.opacity(0.55), OpenClawChatTheme.accent],
                            startPoint: .leading,
                            endPoint: .trailing))
                        : AnyShapeStyle(self.ink),
                    style: stroke)
            if self.fastModeEnabled {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 9.5 * unit, weight: .semibold))
                    .foregroundStyle(OpenClawChatTheme.accent)
                    .offset(y: 2.5 * unit)
            } else {
                CleanChatEffortGaugeNeedle(angle: self.angle)
                    .stroke(self.needleInk, style: stroke)
            }
        }
        .frame(width: self.width, height: 17 * unit)
        .animation(self.reduceMotion ? nil : .easeOut(duration: 0.18), value: self.angle)
    }
}

private struct CleanChatEffortGaugeDial: Shape {
    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 22
        var path = Path()
        path.addArc(
            center: CGPoint(x: rect.midX, y: rect.minY + 11 * unit),
            radius: 10 * unit,
            startAngle: .degrees(150),
            endAngle: .degrees(390),
            clockwise: false)
        return path
    }
}

private struct CleanChatEffortGaugeNeedle: Shape {
    var angle: Double

    var animatableData: Double {
        get { self.angle }
        set { self.angle = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let unit = rect.width / 22
        let hub = CGPoint(x: rect.midX, y: rect.minY + 11 * unit)
        let radians = self.angle * .pi / 180
        var path = Path()
        path.move(to: hub)
        path.addLine(to: CGPoint(
            x: hub.x + 6 * unit * CGFloat(sin(radians)),
            y: hub.y - 6 * unit * CGFloat(cos(radians))))
        return path
    }
}
#endif

struct ChatComposerPlaceholder: View {
    let text: String
    let compactText: String?

    var body: some View {
        Group {
            if let compactText {
                ViewThatFits(in: .horizontal) {
                    Text(self.text)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    Text(compactText)
                        .lineLimit(1)
                }
            } else {
                Text(self.text)
            }
        }
        .font(OpenClawChatTypography.body)
        #if os(iOS)
        .foregroundStyle(OpenClawChatTheme.placeholder)
        #else
        .foregroundStyle(.tertiary)
        #endif
        .allowsHitTesting(false)
    }
}

struct CompactChatAttachmentLabel: View {
    var controlSize: CGFloat = CleanChatComposerMetrics.controlTouchSize

    var body: some View {
        Image(systemName: "plus")
            #if os(iOS)
                .font(OpenClawChatTypography.composerAttachmentGlyph)
                .foregroundStyle(CleanChatComposerMetrics.footerInk)
            #else
                .font(.system(size: OpenClawChatTypography.scaled(20), weight: .semibold))
                .foregroundStyle(.secondary)
            #endif
            .frame(
                width: self.controlSize,
                height: self.controlSize)
            .contentShape(Rectangle())
    }
}

struct CleanChatContextUsageLabel: View {
    let usage: OpenClawChatContextUsage
    var controlSize: CGFloat = CleanChatComposerMetrics.controlTouchSize

    var body: some View {
        #if os(iOS)
        let size = CleanChatComposerMetrics.footerOutlineSize
        let weight = CleanChatComposerMetrics.footerOutlineStroke
        #else
        let size: CGFloat = 18
        let weight: CGFloat = 2.5
        #endif
        return ZStack {
            Circle()
                .stroke(OpenClawChatTheme.muted.opacity(0.2), lineWidth: weight)
            Circle()
                .trim(from: 0, to: max(0.02, self.usage.fractionUsed ?? 0))
                .stroke(self.tint, style: StrokeStyle(lineWidth: weight, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
        .frame(
            width: self.controlSize,
            height: self.controlSize)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context usage")
        .accessibilityValue(self.accessibilityValue)
    }

    private var tint: Color {
        guard let percent = self.usage.percentUsed else { return OpenClawChatTheme.muted }
        if percent >= 90 { return OpenClawChatTheme.danger }
        #if os(macOS)
        if percent >= 75 { return OpenClawChatTheme.warning }
        #else
        if percent >= 80 { return OpenClawChatTheme.warning }
        #endif
        return OpenClawChatTheme.success
    }

    private var accessibilityValue: String {
        if let percent = self.usage.percentUsed {
            return String(
                format: String(localized: "%@ percent of the context window used"),
                percent.formatted())
        }
        return String(
            format: String(localized: "%@ tokens used"),
            self.usage.usedTokens.formatted())
    }
}

@MainActor
public struct OpenClawChatContextUsageControl: View {
    private let usage: OpenClawChatContextUsage
    private let controlSize: CGFloat
    private let items: OpenClawChatContextUsageMenuItems

    public init(
        usage: OpenClawChatContextUsage,
        canCompact: Bool,
        controlSize: CGFloat = 28,
        onCompact: @escaping @MainActor () -> Void)
    {
        self.usage = usage
        self.controlSize = controlSize
        self.items = OpenClawChatContextUsageMenuItems(usage: usage, canCompact: canCompact, onCompact: onCompact)
    }

    public var body: some View {
        Menu {
            self.items
        } label: {
            CleanChatContextUsageLabel(usage: self.usage, controlSize: self.controlSize)
        }
        .menuIndicator(.hidden)
        #if os(macOS)
        .menuStyle(.button)
        .buttonStyle(.plain)
        .fixedSize()
        #endif
        .help(self.items.tokensLine)
        .accessibilityIdentifier("chat-context-usage")
    }
}

/// Shared contents of the context menu, independent of where its button lives.
@MainActor
public struct OpenClawChatContextUsageMenuItems: View {
    private let usage: OpenClawChatContextUsage
    private let canCompact: Bool
    private let onCompact: @MainActor () -> Void

    public init(usage: OpenClawChatContextUsage, canCompact: Bool, onCompact: @escaping @MainActor () -> Void) {
        self.usage = usage
        self.canCompact = canCompact
        self.onCompact = onCompact
    }

    public var body: some View {
        Text(self.tokensLine)
            .font(OpenClawChatTypography.body)
        if let cost = self.usage.totalCost {
            Text(verbatim: String(
                format: String(localized: "Thread cost %@"),
                ChatContextUsageFormatter.cost(cost)))
                .font(OpenClawChatTypography.body)
        }
        Divider()
        Button(action: self.onCompact) {
            Text("Compact Thread")
                .font(OpenClawChatTypography.body)
        }
        .disabled(!self.canCompact)
    }

    var tokensLine: String {
        let used = ChatContextUsageFormatter.tokens(self.usage.usedTokens)
        guard let window = self.usage.contextWindowTokens else {
            return String(format: String(localized: "%@ tokens used"), used)
        }
        return String(
            format: String(localized: "%@ of %@ tokens used"),
            used,
            ChatContextUsageFormatter.tokens(window))
    }
}

struct OpenClawChatAttachmentsStrip: View {
    let attachments: [OpenClawPendingAttachment]
    /// Picked items still being read; iPhone draws them as tiles after the staged ones.
    var preparing: [OpenClawPreparingAttachment] = []
    let onRemove: @MainActor (OpenClawPendingAttachment.ID) -> Void

    /// On iPhone the tiles sit straight on the draft, whose own top inset is the gap below them.
    static var spacingToDraft: CGFloat {
        #if os(iOS)
        0
        #else
        8
        #endif
    }

    var body: some View {
        #if os(iOS)
        ChatAttachmentThumbnailRail(
            tiles: self.attachments.map(ChatAttachmentTileModel.init)
                + self.preparing.map(ChatAttachmentTileModel.init),
            onRemove: self.onRemove)
        #else
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(self.attachments, id: \OpenClawPendingAttachment.id) { attachment in
                    HStack(spacing: 6) {
                        if let image = attachment.preview {
                            OpenClawPlatformImageFactory.image(image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else {
                            Image(systemName: OpenClawChatPickerAttachmentMetadata.fileIcon(
                                mimeType: attachment.mimeType,
                                fileName: attachment.fileName))
                                .accessibilityHidden(true)
                        }

                        if attachment.mimeType.hasPrefix("audio/"), let duration = attachment.durationSeconds {
                            Text("Voice note")
                                .font(OpenClawChatTypography.caption)
                            Text(openClawVoiceNoteDurationLabel(duration))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(attachment.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: 180)
                            if !attachment.mimeType.hasPrefix("image/") {
                                Text(ByteCountFormatter.string(
                                    fromByteCount: Int64(attachment.data.count), countStyle: .file))
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Button {
                            self.onRemove(attachment.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(
                            format: String(localized: "Remove attachment: %@"), attachment.fileName))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(OpenClawChatTheme.accent.opacity(0.08))
                    .clipShape(Capsule())
                    .help(attachment.fileName)
                }
            }
        }
        #endif
    }
}

#if os(iOS)
/// The Control UI's pending attachments on a phone (`ui/src/styles/chat/composer.css`, `.chat-attachments-preview`
/// and `.chat-attachment-*`): an image is a 56 pt square, anything else a 56 pt card with its icon, name and
/// type, and a round remove badge sits on each top-trailing corner. The row scrolls and fades at a clipped edge.
enum ChatAttachmentRailMetrics {
    static let tileSize: CGFloat = 56
    static let tileRadius: CGFloat = 14
    /// Three times the 6 pt attachment block inset, which leaves room for the badges between tiles.
    static let gap: CGFloat = 18
    /// Twice the block inset above the tiles. Below them the editor keeps its own top inset, so the tiles
    /// take the place of the surface's top edge and the text keeps the rhythm it has without attachments.
    static let topInset: CGFloat = 12
    static let badgeSize: CGFloat = 20
    /// The badge's center sits this far in from the tile's top and trailing edges.
    static let badgeCenterInset: CGFloat = 4
    static let badgeHitSize: CGFloat = CleanChatComposerMetrics.controlTouchSize
    /// How far the badge's touch target reaches past the tile; the rail keeps that much room inside its clip.
    static let badgeOverhang: CGFloat = badgeHitSize / 2 - badgeCenterInset
    static let fileIconSize: CGFloat = 40
    /// The retry or reason mark on a failed tile, drawn inside a full touch target.
    static let failureMarkSize: CGFloat = 28
    /// Claude's ring is about a third of its tile wide.
    static let spinnerSize: CGFloat = 20
    static let spinnerLineWidth: CGFloat = 2.5
    static let fileCardMinWidth: CGFloat = 168
    static let fileCardMaxWidth: CGFloat = 216
    static let edgeFade: CGFloat = 48
}

private struct ChatAttachmentThumbnailRail: View {
    let tiles: [ChatAttachmentTileModel]
    let onRemove: @MainActor (OpenClawPendingAttachment.ID) -> Void
    @State private var scroll = ChatAttachmentRailScroll()

    var body: some View {
        let metrics = ChatAttachmentRailMetrics.self
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: metrics.gap) {
                // A prepared attachment keeps its tile's id, so the spinner gives way to it in place.
                ForEach(self.tiles) { tile in
                    ChatAttachmentTile(
                        tile: tile,
                        maxCardWidth: self.scroll.viewportWidth > 0
                            ? max(
                                metrics.fileCardMinWidth,
                                self.scroll.viewportWidth - 2 * CleanChatComposerMetrics.editorInlineInset)
                            : .infinity)
                    {
                        self.onRemove(tile.id)
                    }
                }
            }
            // The tiles start on the draft's leading edge; the badges' touch targets stay inside the clip.
            .padding(.leading, CleanChatComposerMetrics.editorInlineInset)
            .padding(.trailing, CleanChatComposerMetrics.editorInlineInset + metrics.badgeOverhang)
            .padding(.top, metrics.badgeOverhang)
        }
        .onScrollGeometryChange(for: ChatAttachmentRailScroll.self) { geometry in
            ChatAttachmentRailScroll(
                viewportWidth: geometry.containerSize.width,
                clipsLeading: geometry.contentOffset.x > 0.5,
                clipsTrailing: geometry.contentOffset.x + geometry.containerSize.width
                    < geometry.contentSize.width - 0.5)
        } action: { _, scroll in
            self.scroll = scroll
        }
        .mask { self.edgeFadeMask }
        // The badge targets may reach a few points above the surface, as the Control UI's do.
        .padding(.top, metrics.topInset - metrics.badgeOverhang)
    }

    /// The Control UI eases across most of a tile so a partly visible image does not read as a hard border.
    private var edgeFadeMask: some View {
        HStack(spacing: 0) {
            if self.scroll.clipsLeading {
                Self.fade(startPoint: .leading, endPoint: .trailing)
            }
            Rectangle()
            if self.scroll.clipsTrailing {
                Self.fade(startPoint: .trailing, endPoint: .leading)
            }
        }
    }

    private static func fade(startPoint: UnitPoint, endPoint: UnitPoint) -> some View {
        let width = ChatAttachmentRailMetrics.edgeFade
        return LinearGradient(
            stops: [
                .init(color: .clear, location: 4 / width),
                .init(color: .black.opacity(0.12), location: 12 / width),
                .init(color: .black.opacity(0.5), location: 24 / width),
                .init(color: .black.opacity(0.88), location: 36 / width),
                .init(color: .black, location: 1),
            ],
            startPoint: startPoint,
            endPoint: endPoint)
            .frame(width: width)
    }
}

private struct ChatAttachmentRailScroll: Equatable {
    var viewportWidth: CGFloat = 0
    var clipsLeading = false
    var clipsTrailing = false
}

/// What one tile draws: a staged attachment, or a picked item still preparing or failed.
struct ChatAttachmentTileModel: Identifiable {
    enum Status {
        case ready
        case preparing
        case failed(String, retry: (@MainActor () -> Void)?)
    }

    let id: UUID
    let fileName: String
    let mimeType: String
    let preview: OpenClawPlatformImage?
    let durationSeconds: Double?
    /// Unknown until the file is read.
    let byteCount: Int?
    let status: Status

    init(_ attachment: OpenClawPendingAttachment) {
        self.id = attachment.id
        self.fileName = attachment.fileName
        self.mimeType = attachment.mimeType
        self.preview = attachment.preview
        self.durationSeconds = attachment.durationSeconds
        self.byteCount = attachment.data.count
        self.status = .ready
    }

    init(_ preparing: OpenClawPreparingAttachment) {
        self.id = preparing.id
        self.fileName = preparing.fileName
        self.mimeType = preparing.mimeType
        self.preview = preparing.preview
        self.durationSeconds = preparing.durationSeconds
        self.byteCount = nil
        self.status = preparing.failure.map { .failed($0, retry: preparing.retry) } ?? .preparing
    }

    /// An image is a square from the pick on, whether or not its pixels are in hand yet.
    var isImage: Bool {
        self.mimeType.hasPrefix("image/") && (self.preview != nil || !self.isReady)
    }

    var isVoiceNote: Bool {
        self.mimeType.hasPrefix("audio/") && self.durationSeconds != nil
    }

    var isReady: Bool {
        if case .ready = self.status { return true }
        return false
    }
}

struct ChatAttachmentTile: View {
    let tile: ChatAttachmentTileModel
    let maxCardWidth: CGFloat
    let onRemove: @MainActor () -> Void
    @ScaledMetric(relativeTo: .caption) private var cardMinWidth = ChatAttachmentRailMetrics.fileCardMinWidth
    @ScaledMetric(relativeTo: .caption) private var cardMaxWidth = ChatAttachmentRailMetrics.fileCardMaxWidth
    @State private var showsFailure = false

    private var isImage: Bool {
        self.tile.isImage
    }

    private var isVoiceNote: Bool {
        self.tile.isVoiceNote
    }

    private var name: String {
        self.isVoiceNote ? String(localized: "Voice note") : self.tile.fileName
    }

    var body: some View {
        let metrics = ChatAttachmentRailMetrics.self
        let shape = RoundedRectangle(cornerRadius: metrics.tileRadius, style: .continuous)
        self.content
            .clipShape(shape)
            .overlay(shape.strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
            // The tile, not the overflowing fill of a wide photo, is the VoiceOver frame.
            .contentShape(.accessibility, shape)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(self.accessibilityLabel)
            .accessibilityValue(self.accessibilityValue)
            .accessibilityAddTraits(self.isImage && self.tile.isReady ? .isImage : [])
            .overlay { self.failureControl }
            .overlay(alignment: .topTrailing) { self.removeButton }
            .animation(.easeOut(duration: 0.2), value: self.tile.isReady)
            .help(self.tile.fileName)
    }

    private var accessibilityLabel: Text {
        switch self.tile.status {
        case .ready: Text(verbatim: self.name)
        case .preparing: Text(String(format: String(localized: "Preparing %@"), self.name))
        case .failed: Text(String(format: String(localized: "Could not attach: %@"), self.name))
        }
    }

    private var accessibilityValue: Text {
        switch self.tile.status {
        case .ready: Text(verbatim: self.isImage ? "" : self.detail)
        case .preparing: Text(verbatim: "")
        case let .failed(message, _):
            // "Could not attach: <name>" is already the label.
            Text(verbatim: message == String(format: String(localized: "Could not attach: %@"), self.name) ? "" :
                message)
        }
    }

    @ViewBuilder
    private var content: some View {
        let metrics = ChatAttachmentRailMetrics.self
        if self.isImage {
            ZStack {
                if let preview = self.tile.preview {
                    OpenClawPlatformImageFactory.image(preview)
                        .resizable()
                        .scaledToFill()
                        .frame(width: metrics.tileSize, height: metrics.tileSize)
                } else {
                    OpenClawChatTheme.muted.opacity(0.12)
                }
                if !self.tile.isReady {
                    // A photo in hand dims under the spinner; otherwise the spinner sits on a plain fill.
                    if self.tile.preview != nil {
                        Color.black.opacity(0.5)
                    }
                    if case .preparing = self.tile.status {
                        ChatAttachmentSpinner(onPhoto: self.tile.preview != nil)
                    }
                }
            }
            .frame(width: metrics.tileSize, height: metrics.tileSize)
        } else {
            HStack(spacing: 10) {
                self.fileIcon
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.name)
                        .font(OpenClawChatTypography.caption.weight(.medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(verbatim: self.detail)
                        .font(OpenClawChatTypography.caption2)
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .foregroundStyle(OpenClawChatTheme.assistantText)
            }
            .padding(.leading, 7)
            .padding(.trailing, 13)
            .padding(.vertical, 7)
            .frame(
                minWidth: min(self.cardMinWidth, self.maxCardWidth),
                maxWidth: min(self.cardMaxWidth, self.maxCardWidth),
                minHeight: metrics.tileSize,
                alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var fileIcon: some View {
        let metrics = ChatAttachmentRailMetrics.self
        let iconShape = RoundedRectangle(cornerRadius: metrics.tileRadius - 8, style: .continuous)
        if !self.tile.isReady {
            // The spinner, or the failure control drawn over the tile, takes the icon's slot.
            ZStack {
                if case .preparing = self.tile.status {
                    ChatAttachmentSpinner(onPhoto: false)
                }
            }
            .frame(width: metrics.fileIconSize, height: metrics.fileIconSize)
            .background(OpenClawChatTheme.muted.opacity(0.12), in: iconShape)
        } else if self.tile.mimeType.hasPrefix("video/"), let poster = self.tile.preview {
            OpenClawPlatformImageFactory.image(poster)
                .resizable()
                .scaledToFill()
                .frame(width: metrics.fileIconSize, height: metrics.fileIconSize)
                .clipShape(iconShape)
                .overlay {
                    Image(systemName: "play.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(.black.opacity(0.6), in: Circle())
                }
        } else {
            Image(systemName: OpenClawChatPickerAttachmentMetadata.fileIcon(
                mimeType: self.tile.mimeType,
                fileName: self.tile.fileName))
                .font(.system(size: 16))
                .foregroundStyle(OpenClawChatTheme.muted)
                .frame(width: metrics.fileIconSize, height: metrics.fileIconSize)
        }
    }

    /// A failed tile keeps its size: a retry where reading again can help, otherwise a mark that shows why.
    @ViewBuilder
    private var failureControl: some View {
        if case let .failed(message, retry) = self.tile.status {
            let metrics = ChatAttachmentRailMetrics.self
            Button {
                if let retry { retry() } else { self.showsFailure = true }
            } label: {
                Image(systemName: retry == nil ? "exclamationmark" : "arrow.clockwise")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: metrics.failureMarkSize, height: metrics.failureMarkSize)
                    .background(OpenClawChatTheme.danger, in: Circle())
                    .frame(width: metrics.badgeHitSize, height: metrics.badgeHitSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Centered on the square, or on the icon slot of a card.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: self.isImage ? .center : .leading)
            .padding(.leading, self.isImage ? 0 : 7 + (metrics.fileIconSize - metrics.badgeHitSize) / 2)
            .accessibilityLabel(String(localized: "Retry"))
            .accessibilityHidden(retry == nil)
            .popover(isPresented: self.$showsFailure) {
                Text(message)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.assistantText)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 260, alignment: .leading)
                    .padding(12)
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var detail: String {
        Self.detail(for: self.tile)
    }

    static func detail(for attachment: OpenClawPendingAttachment) -> String {
        self.detail(for: ChatAttachmentTileModel(attachment))
    }

    /// The type as the Control UI labels it (the extension in capitals) and the size; a voice note's length.
    /// Before the file is read only the type is known.
    static func detail(for tile: ChatAttachmentTileModel) -> String {
        if tile.mimeType.hasPrefix("audio/"), let duration = tile.durationSeconds {
            return openClawVoiceNoteDurationLabel(duration)
        }
        let fileExtension = (tile.fileName as NSString).pathExtension.uppercased()
        guard let byteCount = tile.byteCount else {
            return fileExtension.isEmpty ? (tile.mimeType as NSString).lastPathComponent.uppercased() : fileExtension
        }
        let size = ByteCountFormatter.string(fromByteCount: Int64(byteCount), countStyle: .file)
        return fileExtension.isEmpty ? size : "\(fileExtension) · \(size)"
    }

    private var removeButton: some View {
        let metrics = ChatAttachmentRailMetrics.self
        return Button(action: self.onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(OpenClawChatTheme.muted)
                .frame(width: metrics.badgeSize, height: metrics.badgeSize)
                .background(OpenClawChatTheme.composerField, in: Circle())
                .overlay(Circle().strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 1, y: 1)
                .frame(width: metrics.badgeHitSize, height: metrics.badgeHitSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .offset(x: metrics.badgeOverhang, y: -metrics.badgeOverhang)
        .accessibilityLabel(String(
            format: String(localized: "Remove attachment: %@"), self.tile.fileName))
    }
}

/// Claude's attachment spinner: a quarter arc turning once a second on a faint ring, white over a dimmed photo.
private struct ChatAttachmentSpinner: View {
    let onPhoto: Bool

    var body: some View {
        let metrics = ChatAttachmentRailMetrics.self
        let ink = self.onPhoto ? Color.white : OpenClawChatTheme.muted
        TimelineView(.animation) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1)
            ZStack {
                Circle()
                    .stroke(ink.opacity(0.3), lineWidth: metrics.spinnerLineWidth)
                Circle()
                    .trim(from: 0, to: 0.25)
                    .stroke(ink, style: StrokeStyle(lineWidth: metrics.spinnerLineWidth, lineCap: .round))
                    .rotationEffect(.degrees(turn * 360))
            }
        }
        .frame(width: metrics.spinnerSize, height: metrics.spinnerSize)
        .accessibilityHidden(true)
    }
}
#endif

#if !os(macOS)
#if canImport(UIKit)
struct OpenClawChatCameraPicker: UIViewControllerRepresentable {
    let onImage: @MainActor (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: OpenClawChatCameraPicker

        init(parent: OpenClawChatCameraPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any])
        {
            if let image = info[.originalImage] as? UIImage {
                self.parent.onImage(image)
            }
            self.parent.dismiss()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            self.parent.dismiss()
        }
    }
}
#endif
#endif

struct OpenClawChatMicButton: View {
    enum DictationPrimaryAction: Equatable {
        case start
        case finish
        case cancel
    }

    let dictationControl: OpenClawChatDictationControl?
    let voiceNoteControl: OpenClawChatVoiceNoteControl?
    let isDictationPending: Bool
    let isRealtimeTalkActive: Bool
    let isComposerEnabled: Bool
    let isAttachmentInputEnabled: Bool
    var controlSize: CGFloat = CleanChatComposerMetrics.controlTouchSize
    var controlWidth: CGFloat?
    let onCancelDictation: @MainActor () -> Void
    let onStartDictation: @MainActor () -> Void

    var body: some View {
        if let voiceNoteControl {
            if self.isDictationActionEnabled, let dictationControl {
                Menu {
                    self.voiceNoteAction(voiceNoteControl)
                } label: {
                    self.label
                } primaryAction: {
                    self.performDictationAction()
                }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .modifier(UnifiedChatMicMetadata(
                    control: dictationControl,
                    isPending: self.isDictationPending))
            } else {
                Menu {
                    self.voiceNoteAction(voiceNoteControl)
                } label: {
                    self.label
                }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .disabled(!self.isVoiceNoteRecordingEnabled(voiceNoteControl))
                .accessibilityLabel("Record Voice Note")
                .accessibilityIdentifier("chat-dictation-control")
                .help("Record Voice Note")
            }
        } else if let dictationControl {
            Button(action: self.performDictationAction) {
                self.label
            }
            .buttonStyle(.plain)
            .disabled(!self.isDictationActionEnabled)
            .modifier(UnifiedChatMicMetadata(
                control: dictationControl,
                isPending: self.isDictationPending))
        }
    }

    private var label: some View {
        let showsStop = self.isDictationPending || self.dictationControl?.isActive == true
        #if os(iOS)
        let font = OpenClawChatTypography.composerGlyph
        let idleTint = CleanChatComposerMetrics.footerInk
        #else
        let font = Font.system(size: OpenClawChatTypography.scaled(17), weight: .medium)
        let idleTint = Color.secondary
        #endif
        return Image(systemName: showsStop ? "stop.fill" : "mic")
            .font(font)
            .foregroundStyle(showsStop ? OpenClawChatTheme.accent : idleTint)
            #if os(iOS)
            .offset(y: showsStop ? 0 : -1)
            #endif
            .frame(width: self.controlWidth ?? self.controlSize, height: self.controlSize)
            .contentShape(Rectangle())
    }

    private func performDictationAction() {
        guard let dictationControl else { return }
        switch Self.dictationPrimaryAction(
            isPending: self.isDictationPending || dictationControl.isActive,
            isActive: dictationControl.phase == .listening)
        {
        case .finish:
            dictationControl.finish()
        case .cancel:
            self.onCancelDictation()
        case .start:
            self.onStartDictation()
        }
    }

    private var isDictationActionEnabled: Bool {
        Self.dictationActionEnabled(
            isComposerEnabled: self.isComposerEnabled,
            isAvailable: self.dictationControl?.isAvailable == true,
            isPending: self.isDictationPending,
            isActive: self.dictationControl?.isActive == true,
            isTalkActive: self.isRealtimeTalkActive || self.voiceNoteControl?.isTalkActive == true,
            isVoiceNoteCaptureActive: self.voiceNoteControl?.recorder.isRecording == true ||
                self.voiceNoteControl?.recorder.isRequestingPermission == true)
    }

    private func voiceNoteAction(_ voiceNoteControl: OpenClawChatVoiceNoteControl) -> some View {
        Button {
            Task { await voiceNoteControl.recorder.start() }
        } label: {
            Label("Record Voice Note", systemImage: "waveform")
        }
        .disabled(!self.isVoiceNoteRecordingEnabled(voiceNoteControl))
    }

    private func isVoiceNoteRecordingEnabled(_ voiceNoteControl: OpenClawChatVoiceNoteControl) -> Bool {
        Self.voiceNoteRecordingEnabled(
            isComposerEnabled: self.isComposerEnabled,
            isAttachmentInputEnabled: self.isAttachmentInputEnabled,
            isDictationActive: self.dictationControl?.isActive == true,
            isDictationPending: self.isDictationPending,
            isTalkActive: self.isRealtimeTalkActive || voiceNoteControl.isTalkActive,
            isRecording: voiceNoteControl.recorder.isRecording,
            isRequestingPermission: voiceNoteControl.recorder.isRequestingPermission)
    }

    nonisolated static func dictationActionEnabled(
        isComposerEnabled: Bool,
        isAvailable: Bool,
        isPending: Bool,
        isActive: Bool,
        isTalkActive: Bool,
        isVoiceNoteCaptureActive: Bool) -> Bool
    {
        isPending || isActive || (isComposerEnabled && isAvailable && !isTalkActive && !isVoiceNoteCaptureActive)
    }

    nonisolated static func dictationPrimaryAction(
        isPending: Bool,
        isActive: Bool) -> DictationPrimaryAction
    {
        if isActive { return .finish }
        if isPending { return .cancel }
        return .start
    }

    nonisolated static func voiceNoteRecordingEnabled(
        isComposerEnabled: Bool,
        isAttachmentInputEnabled: Bool,
        isDictationActive: Bool,
        isDictationPending: Bool,
        isTalkActive: Bool,
        isRecording: Bool,
        isRequestingPermission: Bool) -> Bool
    {
        isComposerEnabled
            && isAttachmentInputEnabled
            && !isDictationActive
            && !isDictationPending
            && !isTalkActive
            && !isRecording
            && !isRequestingPermission
    }
}

private struct UnifiedChatMicMetadata: ViewModifier {
    let control: OpenClawChatDictationControl
    let isPending: Bool

    func body(content: Content) -> some View {
        content
            .accessibilityLabel(self.accessibilityLabel)
            .accessibilityValue(self.accessibilityValue)
            .accessibilityIdentifier("chat-dictation-control")
            .help(self.helpText)
    }

    private var accessibilityLabel: Text {
        if self.control.phase == .listening { return Text("Finish dictation") }
        if self.isPending || self.control.isActive { return Text("Cancel dictation") }
        return Text("Dictate message")
    }

    private var accessibilityValue: Text {
        Text((self.isPending && self.control.phase == .idle
                ? OpenClawChatDictationControl.Phase.starting
                : self.control.phase).statusText)
    }

    private var helpText: Text {
        if self.control.phase == .listening { return Text("Finish dictation") }
        if self.isPending || self.control.isActive { return Text("Cancel dictation") }
        return Text("Dictate")
    }
}
