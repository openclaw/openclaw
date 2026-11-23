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
    /// Puts the first line's cap height about as far from the top edge as the footer glyphs sit from the bottom.
    static let expandedEditorTopInset: CGFloat = 11
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
    let onRemove: @MainActor (OpenClawPendingAttachment.ID) -> Void

    var body: some View {
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
    }
}

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
