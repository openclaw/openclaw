#if os(macOS)
import SwiftUI

@MainActor
public struct OpenClawChatEffortControl: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let thinkingOptions: [OpenClawChatThinkingLevelOption]
    private let thinkingLevel: String?
    private let thinkingIsInherited: Bool
    private let fastModeEnabled: Bool
    private let fastModeIsInherited: Bool
    private let showsFastMode: Bool
    private let supportsFastMode: Bool
    private let isEnabled: Bool
    private let controlHeight: CGFloat
    private let showsLabel: Bool
    private let onSelectThinkingLevel: @MainActor (String?) -> Void
    private let onSelectFastMode: @MainActor (Bool?) -> Void

    @State private var isPresented = false
    @State private var isHovered = false
    @State private var previewIndex: Int?

    private var selectedIndex: Int? {
        self.thinkingOptions.firstIndex { $0.id == self.thinkingLevel }
    }

    private var displayedIndex: Int {
        self.previewIndex ?? self.selectedIndex ?? 0
    }

    private var thinkingLabel: String {
        if let previewIndex, self.thinkingOptions.indices.contains(previewIndex) {
            return self.thinkingOptions[previewIndex].label
        }
        if let selectedIndex {
            return self.thinkingOptions[selectedIndex].label
        }
        return self.thinkingLevel ?? String(localized: "Default")
    }

    private var accessibilityValue: String {
        guard !self.thinkingOptions.isEmpty else {
            return self.fastModeEnabled ? String(localized: "Fast mode on") : String(localized: "Fast mode off")
        }
        let effort = self.thinkingIsInherited
            ? String(format: String(localized: "Inherited %@"), self.thinkingLabel)
            : self.thinkingLabel
        return self.fastModeEnabled
            ? String(format: String(localized: "%@, Fast"), effort)
            : effort
    }

    private var needleAngle: Double {
        guard self.thinkingLevel != "off", let selectedIndex else { return -120 }
        guard self.thinkingOptions.count > 1 else { return 120 }
        return -120 + Double(selectedIndex) / Double(self.thinkingOptions.count - 1) * 240
    }

    public init(
        thinkingOptions: [OpenClawChatThinkingLevelOption],
        thinkingLevel: String?,
        thinkingIsInherited: Bool,
        fastModeEnabled: Bool,
        fastModeIsInherited: Bool,
        showsFastMode: Bool,
        supportsFastMode: Bool,
        isEnabled: Bool = true,
        controlHeight: CGFloat = 30,
        showsLabel: Bool = true,
        onSelectThinkingLevel: @escaping @MainActor (String?) -> Void,
        onSelectFastMode: @escaping @MainActor (Bool?) -> Void)
    {
        self.thinkingOptions = thinkingOptions
        self.thinkingLevel = thinkingLevel
        self.thinkingIsInherited = thinkingIsInherited
        self.fastModeEnabled = fastModeEnabled
        self.fastModeIsInherited = fastModeIsInherited
        self.showsFastMode = showsFastMode
        self.supportsFastMode = supportsFastMode
        self.isEnabled = isEnabled
        self.controlHeight = controlHeight
        self.showsLabel = showsLabel
        self.onSelectThinkingLevel = onSelectThinkingLevel
        self.onSelectFastMode = onSelectFastMode
    }

    public var body: some View {
        if !self.thinkingOptions.isEmpty || self.showsFastMode {
            Button {
                self.previewIndex = nil
                self.isPresented.toggle()
            } label: {
                self.triggerLabel
            }
            .buttonStyle(.plain)
            .disabled(!self.isEnabled)
            .onHover { self.isHovered = $0 }
            .popover(isPresented: self.$isPresented, arrowEdge: .bottom) {
                self.popoverContent
            }
            .help(self.accessibilityValue)
            .accessibilityLabel("Effort")
            .accessibilityValue(self.accessibilityValue)
            .accessibilityIdentifier("chat-composer-inline-effort")
            .onChange(of: self.thinkingOptions) { _, _ in self.previewIndex = nil }
            .onChange(of: self.thinkingLevel) { _, _ in self.previewIndex = nil }
            .onChange(of: self.isEnabled) { _, _ in self.previewIndex = nil }
        }
    }

    private var triggerLabel: some View {
        HStack(spacing: 6) {
            if !self.thinkingOptions.isEmpty {
                ChatEffortGauge(angle: self.needleAngle, isOff: self.thinkingLevel == "off")
                    .animation(self.reduceMotion ? nil : .easeOut(duration: 0.18), value: self.needleAngle)
            }
            if self.fastModeEnabled || self.thinkingOptions.isEmpty {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tint)
            }
            if self.showsLabel {
                Text(self.thinkingOptions.isEmpty ? String(localized: "Fast") : self.thinkingLabel)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .padding(.horizontal, self.showsLabel ? 7 : 0)
        .frame(minWidth: self.controlHeight, minHeight: self.controlHeight)
        .background(
            Color.primary.opacity(self.isHovered || self.isPresented ? 0.06 : 0),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityHidden(true)
    }

    private var popoverContent: some View {
        VStack(spacing: 0) {
            if !self.thinkingOptions.isEmpty {
                self.thinkingPanel
            }
            if self.showsFastMode {
                if !self.thinkingOptions.isEmpty {
                    Divider()
                }
                self.fastModePanel
            }
        }
        .frame(width: 270)
        .disabled(!self.isEnabled)
        .onExitCommand { self.isPresented = false }
        .onDisappear { self.previewIndex = nil }
    }

    private var thinkingPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Effort")
                    .fontWeight(.semibold)
                Spacer()
                Text(self.thinkingLabel)
                    .fontWeight(.semibold)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
            if self.thinkingOptions.count > 1 {
                ChatEffortSlider(
                    options: self.thinkingOptions,
                    index: self.displayedIndex,
                    isInherited: self.thinkingIsInherited && self.previewIndex == nil,
                    isUnanchored: self.selectedIndex == nil && self.previewIndex == nil,
                    accessibilityValue: self.accessibilityValue,
                    onPreview: { self.previewIndex = $0 },
                    onCommit: self.commitThinking)
                HStack {
                    Text("Faster")
                    Spacer()
                    Text("Smarter")
                }
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .accessibilityHidden(true)
            } else if let option = self.thinkingOptions.first {
                Button {
                    self.commitThinking(0)
                } label: {
                    HStack {
                        Text(option.label)
                        Spacer()
                        if self.selectedIndex == 0 {
                            Image(systemName: "checkmark")
                                .foregroundStyle(.tint)
                        }
                    }
                    .padding(8)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(self.selectedIndex == 0 ? .isSelected : [])
            }
            self.defaultControl(isInherited: self.thinkingIsInherited) {
                self.previewIndex = nil
                self.onSelectThinkingLevel(nil)
            }
        }
        .font(.system(size: 12))
        .padding(14)
    }

    private var fastModePanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(
                get: { self.fastModeEnabled },
                set: { self.onSelectFastMode($0) }))
            {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "bolt.fill")
                        .foregroundStyle(.tint)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Fast mode")
                            .fontWeight(.medium)
                        Text("Faster responses, higher usage of limits.")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(!self.supportsFastMode)
            .accessibilityLabel("Fast mode")
            self.defaultControl(isInherited: self.fastModeIsInherited) {
                self.onSelectFastMode(nil)
            }
        }
        .font(.system(size: 12))
        .padding(14)
    }

    @ViewBuilder
    private func defaultControl(isInherited: Bool, action: @escaping @MainActor () -> Void) -> some View {
        if !isInherited {
            Button("Use session default", action: action)
                .buttonStyle(.plain)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
    }

    private func commitThinking(_ index: Int) {
        self.previewIndex = nil
        guard self.isEnabled, self.thinkingOptions.indices.contains(index) else { return }
        let option = self.thinkingOptions[index]
        guard self.thinkingIsInherited || option.id != self.thinkingLevel else { return }
        self.onSelectThinkingLevel(option.id)
    }
}

private struct ChatEffortGauge: View {
    let angle: Double
    let isOff: Bool

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0, to: 2 / 3)
                .stroke(.secondary.opacity(0.65), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                .rotationEffect(.degrees(150))
            Capsule()
                .fill(.primary)
                .frame(width: 1.5, height: 5)
                .offset(y: -2.5)
                .rotationEffect(.degrees(self.angle))
            Circle()
                .fill(.primary)
                .frame(width: 2, height: 2)
        }
        .frame(width: 17, height: 17)
        .opacity(self.isOff ? 0.55 : 1)
    }
}

private struct ChatEffortSlider: View {
    let options: [OpenClawChatThinkingLevelOption]
    let index: Int
    let isInherited: Bool
    let isUnanchored: Bool
    let accessibilityValue: String
    let onPreview: (Int) -> Void
    let onCommit: (Int) -> Void

    @FocusState private var isFocused: Bool

    private var selection: Binding<Double> {
        Binding(get: { Double(self.index) }, set: { self.onCommit(Int($0.rounded())) })
    }

    var body: some View {
        GeometryReader { geometry in
            let travel = max(1, geometry.size.width - 32)
            let offset = travel * CGFloat(self.index) / CGFloat(self.options.count - 1)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.06))
                Capsule()
                    .fill(Color.primary.opacity(0.10))
                    .frame(width: offset + 18)
                HStack(spacing: 0) {
                    ForEach(self.options.indices, id: \.self) { index in
                        if index > 0 { Spacer(minLength: 0) }
                        Circle()
                            .fill(Color.primary.opacity(0.28))
                            .frame(width: 4, height: 4)
                    }
                }
                .padding(.horizontal, 14)
                Capsule()
                    .fill(self.isInherited ? Color.secondary : Color.primary)
                    .opacity(self.isUnanchored ? 0.35 : 1)
                    .frame(width: 28, height: 20)
                    .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                    .offset(x: offset + 2)
            }
            .overlay {
                if self.isFocused {
                    Capsule().strokeBorder(.tint, lineWidth: 2)
                } else {
                    Capsule().strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                }
            }
            .contentShape(Capsule())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { value in
                    self.isFocused = true
                    self.onPreview(self.stop(at: value.location.x, travel: travel))
                }
                .onEnded { value in
                    self.onCommit(self.stop(at: value.location.x, travel: travel))
                })
        }
        .frame(height: 26)
        .focusable()
        .focused(self.$isFocused)
        .focusEffectDisabled()
        .onMoveCommand { direction in
            switch direction {
            case .left, .down: self.onCommit(max(0, self.index - 1))
            case .right, .up: self.onCommit(min(self.options.count - 1, self.index + 1))
            @unknown default: break
            }
        }
        .onKeyPress(.home) {
            self.onCommit(0)
            return .handled
        }
        .onKeyPress(.end) {
            self.onCommit(self.options.count - 1)
            return .handled
        }
        .accessibilityRepresentation {
            Slider(value: self.selection, in: 0...Double(self.options.count - 1), step: 1) {
                Text("Thinking effort")
            }
            .accessibilityValue(self.accessibilityValue)
        }
        .accessibilityIdentifier("chat-thinking-effort-slider")
    }

    private func stop(at location: CGFloat, travel: CGFloat) -> Int {
        let fraction = min(1, max(0, (location - 16) / travel))
        return Int((fraction * CGFloat(self.options.count - 1)).rounded())
    }
}
#endif
