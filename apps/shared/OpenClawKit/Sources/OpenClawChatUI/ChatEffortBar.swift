#if os(iOS)
import SwiftUI

/// The phone effort bar: the level on a draggable track with one stop per level the model offers, and
/// the speed when the model has speed options. Only levels show; the name on the right follows the drag.
struct ChatEffortBar: View {
    let viewModel: OpenClawChatViewModel
    /// In the model sheet's Effort page the bar sits in a list row, which draws its own card.
    var isSheetPage = false
    @State private var previewIndex: Int?

    var body: some View {
        let options = self.viewModel.showsThinkingPicker ? self.viewModel.thinkingLevelOptions : []
        let current = OpenClawChatViewModel.normalizedThinkingLevel(self.viewModel.thinkingLevel)
        let selectedIndex = options.firstIndex { OpenClawChatViewModel.normalizedThinkingLevel($0.id) == current }
        let shownIndex = self.previewIndex ?? selectedIndex
        let level = shownIndex.map { options[$0].displayLabel }
            ?? OpenClawChatThinkingLevelOption.displayLabel(for: self.viewModel.thinkingLevel)
        let lockReason = self.viewModel.composerPhoneEffortLockReason
        let showsInlineSpeed = !self.isSheetPage && self.viewModel.selectedModelSupportsFastMode
        // Saves happen in the background; only a missing permission locks the controls.
        let isEnabled = lockReason == nil
        VStack(alignment: .leading, spacing: 10) {
            if !options.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("Effort")
                        .font(self.isSheetPage ? OpenClawChatTypography.settingsBody :
                            OpenClawChatTypography.body(size: 15, weight: .regular, relativeTo: .subheadline))
                        .foregroundStyle(self.isSheetPage ? Color.primary : OpenClawChatTheme.muted)
                    Spacer(minLength: 8)
                    Text(verbatim: level)
                        .font(self.isSheetPage ? OpenClawChatTypography.settingsBody :
                            OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .subheadline))
                        .foregroundStyle(self.isSheetPage ? Color(uiColor: .secondaryLabel) : Color.primary)
                        .accessibilityIdentifier("chat-effort-bar-level")
                }
                .accessibilityHidden(true)
                if options.count > 1 {
                    ChatEffortTrack(
                        count: options.count,
                        index: shownIndex,
                        valueLabel: level,
                        onPreview: { self.previewIndex = $0 },
                        onCommit: { index in
                            self.previewIndex = nil
                            guard index != selectedIndex || self.viewModel.thinkingOverrideIsInherited else { return }
                            self.viewModel.selectThinkingLevel(options[index].id)
                        })
                        .disabled(!isEnabled)
                } else {
                    // One level: nothing to choose, but VoiceOver still reads it.
                    Color.clear.frame(height: 0)
                        .accessibilityElement()
                        .accessibilityLabel(Text("Effort"))
                        .accessibilityValue(Text(verbatim: level))
                }
            }
            if showsInlineSpeed {
                HStack(spacing: 12) {
                    Text("Speed")
                        .font(OpenClawChatTypography.body(size: 15, weight: .regular, relativeTo: .subheadline))
                        .foregroundStyle(OpenClawChatTheme.muted)
                        .accessibilityHidden(true)
                    Spacer(minLength: 8)
                    ChatEffortSpeedPicker(viewModel: self.viewModel)
                        .pickerStyle(.segmented)
                        .controlSize(.large)
                        .fixedSize()
                }
                .frame(minHeight: ChatEffortBarMetrics.touch)
            }
            if let lockReason {
                Text(verbatim: lockReason)
                    .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .footnote))
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("chat-effort-bar-locked")
            }
        }
        .padding(.horizontal, self.isSheetPage ? 0 : 16)
        .padding(.top, self.isSheetPage ? 6 : 14)
        .padding(.bottom, showsInlineSpeed && lockReason == nil ? 8 : 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(ChatEffortBarSurface(isSheetPage: self.isSheetPage))
        .onChange(of: self.viewModel.thinkingLevelOptions) { _, _ in self.previewIndex = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-effort-bar")
    }

    static func speedLabel(_ option: String) -> String {
        switch option {
        case "on": String(localized: "Fast")
        case "ultrafast": String(localized: "Ultrafast")
        default: String(localized: "Standard")
        }
    }
}

/// The composer presents these choices inline; the model sheet presents them in a Settings-style row.
struct ChatEffortSpeedPicker: View {
    let viewModel: OpenClawChatViewModel

    var body: some View {
        Picker(selection: Binding(
            get: { self.viewModel.composerSpeedSelection },
            set: { self.viewModel.selectFastMode($0) }))
        {
            ForEach(self.viewModel.composerSpeedOptions, id: \.self) { option in
                Text(verbatim: ChatEffortBar.speedLabel(option)).tag(option)
            }
        } label: {
            Text("Speed").font(OpenClawChatTypography.settingsBody).foregroundStyle(.primary)
        }
        .disabled(self.viewModel.composerPhoneEffortLockReason != nil)
        .accessibilityIdentifier("chat-effort-bar-speed")
    }
}

/// A track with one stop per level and a thumb that snaps to the nearest stop when released.
private struct ChatEffortTrack: View {
    let count: Int
    /// Nil when the current level is not one the model lists: the thumb waits at the first stop, dimmed.
    let index: Int?
    let valueLabel: String
    let onPreview: (Int) -> Void
    let onCommit: (Int) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled
    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 32
    @State private var width: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            let thumbWidth = ChatEffortBarMetrics.thumbWidth
            let travel = max(1, geometry.size.width - thumbWidth - 6)
            let position = CGFloat(self.index ?? 0) / CGFloat(max(1, self.count - 1))
            let thumbX = 3 + travel * position
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.06))
                if self.index != nil {
                    Capsule()
                        .fill(Color.primary.opacity(0.08))
                        .frame(width: thumbX + thumbWidth + 3)
                }
                ForEach(0..<self.count, id: \.self) { stop in
                    Circle()
                        .fill(OpenClawChatTheme.placeholder.opacity(0.8))
                        .frame(width: 4, height: 4)
                        .position(
                            x: 3 + thumbWidth / 2 + travel * CGFloat(stop) / CGFloat(max(1, self.count - 1)),
                            y: geometry.size.height / 2)
                }
                Capsule()
                    .fill(OpenClawChatTheme.assistantText)
                    .opacity(self.index == nil ? 0.35 : 1)
                    .frame(width: thumbWidth, height: geometry.size.height - 6)
                    .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
                    .offset(x: thumbX)
                    .animation(self.reduceMotion ? nil : .snappy(duration: 0.18), value: self.index)
            }
            // Drawn as one layer: on the glass surface, vibrant fills would let the stops show through.
            .compositingGroup()
            .opacity(self.isEnabled ? 1 : 0.4)
        }
        .frame(height: self.height)
        // The track draws at 32 pt; the touch target reaches 44.
        .padding(.vertical, max(0, (ChatEffortBarMetrics.touch - self.height) / 2))
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { value in
                self.onPreview(self.stop(at: value.location.x))
            }
            .onEnded { value in
                self.onCommit(self.stop(at: value.location.x))
            })
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { self.width = $0 }
        .sensoryFeedback(.selection, trigger: self.index)
        .accessibilityRepresentation {
            Slider(
                value: Binding(
                    get: { Double(self.index ?? 0) },
                    set: { self.onCommit(Int($0.rounded())) }),
                in: 0...Double(self.count - 1),
                step: 1)
            {
                Text("Effort")
            }
            .accessibilityValue(Text(verbatim: self.valueLabel))
        }
        .accessibilityIdentifier("chat-effort-bar-slider")
    }

    private func stop(at location: CGFloat) -> Int {
        let travel = max(1, self.width - ChatEffortBarMetrics.thumbWidth - 6)
        let fraction = min(1, max(0, (location - 3 - ChatEffortBarMetrics.thumbWidth / 2) / travel))
        return Int((fraction * CGFloat(self.count - 1)).rounded())
    }
}

/// The floating bar's surface over the composer; none in a sheet list row.
private struct ChatEffortBarSurface: ViewModifier {
    let isSheetPage: Bool

    func body(content: Content) -> some View {
        if self.isSheetPage {
            content
        } else {
            content.modifier(CleanChatComposerSurface(cornerRadius: ChatEffortBarMetrics.radius))
        }
    }
}

enum ChatEffortBarMetrics {
    static let radius: CGFloat = 26
    static let thumbWidth: CGFloat = 38
    static let touch: CGFloat = 44
}

extension OpenClawChatViewModel {
    /// The effort chip's VoiceOver value: the level, and the speed when it is not Standard.
    var composerPhoneEffortLabel: String {
        guard self.showsThinkingPicker else { return ChatEffortBar.speedLabel(self.composerSpeedSelection) }
        let level = self.thinkingLevelOptions.first { $0.id == self.thinkingLevel }?.displayLabel
            ?? OpenClawChatThinkingLevelOption.displayLabel(for: self.thinkingLevel)
        switch self.composerSpeedSelection {
        case "on": return String(format: String(localized: "%@, Fast"), level)
        case "ultrafast": return String(format: String(localized: "%@, Ultrafast"), level)
        default: return level
        }
    }
}

extension OpenClawChatThinkingLevelOption {
    /// The level's name as the Control UI writes it (ui/src/lib/chat/thinking.ts); catalogs send raw ids.
    @MainActor
    var displayLabel: String {
        Self.displayLabel(for: self.id, fallback: self.label)
    }

    @MainActor
    static func displayLabel(for id: String, fallback: String? = nil) -> String {
        switch OpenClawChatViewModel.normalizedThinkingLevel(id) {
        case "off": String(localized: "Off")
        case "adaptive": String(localized: "Adaptive")
        case "minimal": String(localized: "Minimal")
        case "low": String(localized: "Low")
        case "medium": String(localized: "Medium")
        case "high": String(localized: "High")
        case "xhigh": String(localized: "Extra high")
        case "max": String(localized: "Maximum")
        case "ultra": String(localized: "Ultra")
        default:
            (fallback?.trimmedNonEmpty ?? id).prefix(1).uppercased() + (fallback?.trimmedNonEmpty ?? id).dropFirst()
        }
    }
}
#endif
