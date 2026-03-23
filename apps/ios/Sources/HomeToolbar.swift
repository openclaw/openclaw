import SwiftUI

struct HomeToolbar: View {
    var gateway: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var activity: StatusPill.Activity?
    var brighten: Bool
    var talkButtonEnabled: Bool
    var talkActive: Bool
    var talkTint: Color
    var onStatusTap: () -> Void
    var onChatTap: () -> Void
    var onTalkTap: () -> Void
    var onSettingsTap: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 10) {
            HomeToolbarStatusButton(
                gateway: self.gateway,
                voiceWakeEnabled: self.voiceWakeEnabled,
                activity: self.activity,
                brighten: self.brighten,
                onTap: self.onStatusTap)
                .homeToolbarSurface(brighten: self.brighten, contrast: self.contrast)

            Spacer(minLength: 10)

            HStack(spacing: 6) {
                HomeToolbarActionButton(
                    systemImage: "text.bubble.fill",
                    accessibilityLabel: "Chat",
                    brighten: self.brighten,
                    action: self.onChatTap)

                if self.talkButtonEnabled {
                    HomeToolbarActionButton(
                        systemImage: self.talkActive ? "waveform.circle.fill" : "waveform.circle",
                        accessibilityLabel: self.talkActive ? "Talk Mode On" : "Talk Mode Off",
                        brighten: self.brighten,
                        tint: self.talkTint,
                        isActive: self.talkActive,
                        action: self.onTalkTap)
                }

                HomeToolbarActionButton(
                    systemImage: "gearshape.fill",
                    accessibilityLabel: "Settings",
                    brighten: self.brighten,
                    action: self.onSettingsTap)
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 7)
            .homeToolbarSurface(brighten: self.brighten, contrast: self.contrast)
        }
    }
}

private struct HomeToolbarStatusButton: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var gateway: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var activity: StatusPill.Activity?
    var brighten: Bool
    var onTap: () -> Void

    @State private var pulse: Bool = false

    var body: some View {
        Button(action: self.onTap) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(self.gateway.color)
                        .frame(width: 8, height: 8)
                        .scaleEffect(
                            self.gateway == .connecting && !self.reduceMotion
                                ? (self.pulse ? 1.15 : 0.85)
                                : 1.0
                        )
                        .opacity(self.gateway == .connecting && !self.reduceMotion ? (self.pulse ? 1.0 : 0.6) : 1.0)

                    Text(self.gateway.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }

                if let activity {
                    Image(systemName: activity.systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(activity.tint ?? .primary)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Image(systemName: self.voiceWakeEnabled ? "mic.fill" : "mic.slash")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(self.voiceWakeEnabled ? .primary : .secondary)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
        }
        .homeToolbarButtonStyle(prominent: false, tint: nil)
        .accessibilityLabel("Connection Status")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityHint(self.gateway == .connected ? "Double tap for gateway actions" : "Double tap to open settings")
        .onAppear { self.updatePulse(for: self.gateway, scenePhase: self.scenePhase, reduceMotion: self.reduceMotion) }
        .onDisappear { self.pulse = false }
        .onChange(of: self.gateway) { _, newValue in
            self.updatePulse(for: newValue, scenePhase: self.scenePhase, reduceMotion: self.reduceMotion)
        }
        .onChange(of: self.scenePhase) { _, newValue in
            self.updatePulse(for: self.gateway, scenePhase: newValue, reduceMotion: self.reduceMotion)
        }
        .onChange(of: self.reduceMotion) { _, newValue in
            self.updatePulse(for: self.gateway, scenePhase: self.scenePhase, reduceMotion: newValue)
        }
        .animation(.easeInOut(duration: 0.18), value: self.activity?.title)
    }

    private var accessibilityValue: String {
        if let activity {
            return "\(self.gateway.title), \(activity.title)"
        }
        return "\(self.gateway.title), Voice Wake \(self.voiceWakeEnabled ? "enabled" : "disabled")"
    }

    private func updatePulse(for gateway: StatusPill.GatewayState, scenePhase: ScenePhase, reduceMotion: Bool) {
        guard gateway == .connecting, scenePhase == .active, !reduceMotion else {
            withAnimation(reduceMotion ? .none : .easeOut(duration: 0.2)) { self.pulse = false }
            return
        }

        guard !self.pulse else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            self.pulse = true
        }
    }
}

private struct HomeToolbarActionButton: View {
    let systemImage: String
    let accessibilityLabel: String
    let brighten: Bool
    var tint: Color?
    var isActive: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(self.isActive ? (self.tint ?? .primary) : .primary)
                .frame(width: 38, height: 38)
        }
        .homeToolbarButtonStyle(prominent: self.isActive, tint: self.tint)
        .accessibilityLabel(self.accessibilityLabel)
    }
}

private struct HomeToolbarSurfaceModifier: ViewModifier {
    let brighten: Bool
    let contrast: ColorSchemeContrast

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .glassEffect(.regular, in: Capsule())
                .shadow(color: .black.opacity(self.brighten ? 0.07 : 0.10), radius: 10, y: 3)
        } else {
            content
                .background {
                    Capsule(style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            Capsule(style: .continuous)
                                .strokeBorder(
                                    .white.opacity(self.contrast == .increased ? 0.34 : 0.12),
                                    lineWidth: self.contrast == .increased ? 1.0 : 0.6)
                        }
                        .shadow(color: .black.opacity(self.brighten ? 0.08 : 0.12), radius: 10, y: 3)
                }
                .overlay {
                    LinearGradient(
                        colors: [
                            .white.opacity(self.brighten ? 0.08 : 0.05),
                            .clear,
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)
                        .allowsHitTesting(false)
                        .clipShape(Capsule(style: .continuous))
                }
        }
    }
}

private struct HomeToolbarButtonStyleModifier: ViewModifier {
    let prominent: Bool
    let tint: Color?

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            if self.prominent {
                content
                    .buttonStyle(GlassProminentButtonStyle())
                    .tint(self.tint ?? .primary)
            } else {
                content.buttonStyle(GlassButtonStyle())
            }
        } else {
            content.buttonStyle(.plain)
        }
    }
}

private extension View {
    func homeToolbarSurface(brighten: Bool, contrast: ColorSchemeContrast) -> some View {
        self.modifier(HomeToolbarSurfaceModifier(brighten: brighten, contrast: contrast))
    }

    func homeToolbarButtonStyle(prominent: Bool, tint: Color?) -> some View {
        self.modifier(HomeToolbarButtonStyleModifier(prominent: prominent, tint: tint))
    }
}
