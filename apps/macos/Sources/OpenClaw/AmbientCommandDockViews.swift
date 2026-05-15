import AppKit
import OpenClawKit
import SwiftUI

struct AmbientThomasOrbView: View {
    let state: AmbientThomasOrbState

    private static let thomasImage: NSImage? = {
        let bundle = OpenClawKitResources.bundle
        let url = bundle.url(
            forResource: "thomas_avatar",
            withExtension: "png",
            subdirectory: "CanvasScaffold")
            ?? bundle.url(forResource: "thomas_avatar", withExtension: "png")
        return url.flatMap { NSImage(contentsOf: $0) }
    }()

    var body: some View {
        let profile = AmbientThomasOrbMotionProfile.profile(for: self.state)

        TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            let motion = AmbientThomasOrbMotionSample.sample(time: time, state: self.state)
            let orbit = Angle.degrees(motion.spinDegrees)

            ZStack {
                Circle()
                    .stroke(self.ringColor.opacity(0.28), lineWidth: 1.2)
                    .scaleEffect(self.pulseScale(time: time, seconds: profile.pulseSeconds))
                    .opacity(self.pulseOpacity(time: time, seconds: profile.pulseSeconds))

                Circle()
                    .fill(
                        AngularGradient(
                            colors: [.cyan, .mint, .yellow, .pink, .cyan],
                            center: .center,
                            angle: orbit))
                    .shadow(color: self.ringColor.opacity(profile.glowOpacity), radius: 26)
                    .padding(3)

                Circle()
                    .fill(.black.opacity(0.66))
                    .padding(9)

                self.thomasImage
                    .clipShape(Circle())
                    .overlay(Circle().stroke(.white.opacity(0.42), lineWidth: 2))
                    .padding(13)

                Circle()
                    .fill(self.statusColor)
                    .frame(width: 15, height: 15)
                    .overlay(Circle().stroke(.black.opacity(0.8), lineWidth: 2))
                    .offset(x: 29, y: 29)

                Circle()
                    .fill(.yellow)
                    .frame(width: 10, height: 10)
                    .shadow(color: .yellow.opacity(0.8), radius: 12)
                    .offset(x: 37, y: -37)

                Circle()
                    .fill(.cyan)
                    .frame(width: 7, height: 7)
                    .shadow(color: .cyan.opacity(0.8), radius: 10)
                    .offset(x: -39, y: 24)
            }
            .frame(width: 92, height: 92)
            .scaleEffect(self.breatheScale(time: time, seconds: profile.pulseSeconds))
            .rotationEffect(.degrees(motion.tiltDegrees))
            .offset(x: motion.offsetX, y: motion.offsetY)
            .accessibilityHidden(true)
        }
        .frame(width: 190, height: 184)
    }

    @ViewBuilder
    private var thomasImage: some View {
        if let image = Self.thomasImage {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
        } else {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
        }
    }

    private var ringColor: Color {
        switch self.state {
        case .ready:
            .cyan
        case .focused:
            .mint
        case .sending:
            .yellow
        case .working:
            .cyan
        case .success:
            .green
        case .error:
            .orange
        }
    }

    private var statusColor: Color {
        switch self.state {
        case .ready, .focused:
            .mint
        case .sending, .working:
            .yellow
        case .success:
            .green
        case .error:
            .orange
        }
    }

    private func breatheScale(time: TimeInterval, seconds: Double) -> Double {
        1.0 + sin(time * 2 * .pi / seconds) * 0.035
    }

    private func pulseScale(time: TimeInterval, seconds: Double) -> Double {
        1.08 + (sin(time * 2 * .pi / seconds) + 1) * 0.14
    }

    private func pulseOpacity(time: TimeInterval, seconds: Double) -> Double {
        0.18 + (sin(time * 2 * .pi / seconds) + 1) * 0.12
    }
}

struct AmbientCommandDockView: View {
    @Bindable var model: AmbientCommandDockModel
    let onDismiss: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 8) {
            AmbientThomasOrbView(state: self.model.thomasState)
                .frame(height: 134)

            VStack(spacing: 0) {
                self.header

                if !self.model.suggestions.isEmpty {
                    self.suggestionsList
                }

                self.resultStrip
                self.inputRow
            }
            .frame(width: 820)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.white.opacity(0.18), lineWidth: 1))
            .shadow(color: .black.opacity(0.30), radius: 28, x: 0, y: 18)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .onAppear { self.focused = true }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(.mint)
                .frame(width: 8, height: 8)
                .shadow(color: .mint.opacity(0.7), radius: 8)
            Text("Thomas")
                .font(.system(size: 12, weight: .semibold))
            Text(self.model.sessionLabel)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
            Text("/help")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("Esc")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var suggestionsList: some View {
        VStack(spacing: 4) {
            ForEach(Array(self.model.suggestions.enumerated()), id: \.element.id) { index, spec in
                AmbientCommandSuggestionRow(
                    spec: spec,
                    isSelected: index == self.model.selectedSuggestionIndex)
                    .onTapGesture { self.model.acceptSuggestion(spec) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var resultStrip: some View {
        switch self.model.result {
        case .none:
            EmptyView()
        case let .success(message), let .failure(message), let .info(message):
            Text(message)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
        }
    }

    private var inputRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)

            TextField("Ask Thomas or type / for commands...", text: self.$model.inputText)
                .textFieldStyle(.plain)
                .focused(self.$focused)
                .font(.system(size: 14, weight: .regular))
                .onSubmit {
                    if let selected = self.model.suggestions[safe: self.model.selectedSuggestionIndex] {
                        self.model.acceptSuggestion(selected)
                    }
                }

            Button(action: self.onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .frame(width: 28, height: 28)
            .background(.white.opacity(0.08), in: Circle())
        }
        .padding(.leading, 13)
        .padding(.trailing, 9)
        .frame(height: 46)
        .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(.white.opacity(0.11), lineWidth: 1))
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
    }
}

struct AmbientCommandSuggestionRow: View {
    let spec: AmbientCommandSpec
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text(spec.displayName)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .frame(width: 140, alignment: .leading)
            Text(spec.description)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Text(spec.group.title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            self.isSelected ? .cyan.opacity(0.14) : .white.opacity(0.06),
            in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(self.isSelected ? .cyan.opacity(0.22) : .clear, lineWidth: 1))
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
