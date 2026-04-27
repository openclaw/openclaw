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
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                HomeToolbarStatusButton(
                    gateway: self.gateway,
                    voiceWakeEnabled: self.voiceWakeEnabled,
                    activity: self.activity,
                    brighten: self.brighten,
                    onTap: self.onStatusTap)

                Spacer(minLength: 0)

                HStack(spacing: 14) {
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
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity)
        .background {
            ZStack(alignment: .top) {
                Rectangle()
                    .fill(.ultraThinMaterial)
                LinearGradient(
                    colors: [
                        .white.opacity(self.brighten ? 0.14 : 0.09),
                        .white.opacity(self.brighten ? 0.03 : 0.015),
                        .clear,
                    ],
                    startPoint: .top,
                    endPoint: .bottom)
                Rectangle()
                    .fill(.white.opacity(self.contrast == .increased ? 0.42 : (self.brighten ? 0.16 : 0.1)))
                    .frame(height: self.contrast == .increased ? 1.0 : 0.6)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .shadow(color: .black.opacity(0.16), radius: 18, y: -4)
    }
}

private struct HomeToolbarStatusButton: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

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
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(self.brighten ? 0.12 : 0.06),
                                Color.black.opacity(self.brighten ? 0.1 : 0.18),
                            ],
                            startPoint: .top,
                            endPoint: .bottom)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(
                                .white.opacity(self.contrast == .increased ? 0.46 : (self.brighten ? 0.22 : 0.16)),
                                lineWidth: self.contrast == .increased ? 1.0 : 0.6)
                    }
                    .shadow(color: .black.opacity(0.14), radius: 12, y: 5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Connection Status")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityHint(
            self.gateway == .connected
                ? "Double tap for gateway actions"
                : "Double tap to open settings")
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
    @Environment(\.colorSchemeContrast) private var contrast

    let systemImage: String
    let accessibilityLabel: String
    let brighten: Bool
    var tint: Color?
    var isActive: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(self.isActive ? (self.tint ?? .primary) : .primary)
                .frame(width: 48, height: 48)
                .background {
                    RoundedRectangle(cornerRadius: 15, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(self.brighten ? 0.11 : 0.05),
                                    Color.black.opacity(self.brighten ? 0.1 : 0.18),
                                ],
                                startPoint: .top,
                                endPoint: .bottom)
                        )
                        .overlay {
                            if let tint {
                                RoundedRectangle(cornerRadius: 15, style: .continuous)
                                    .fill(
                                        LinearGradient(
                                            colors: [
                                                tint.opacity(self.isActive ? 0.22 : 0.14),
                                                tint.opacity(self.isActive ? 0.08 : 0.04),
                                                .clear,
                                            ],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing))
                                    .blendMode(.overlay)
                            }
                        }
                        .overlay {
                            if self.isActive, let tint {
                                RoundedRectangle(cornerRadius: 15, style: .continuous)
                                    .strokeBorder(tint.opacity(0.24), lineWidth: 1.2)
                                    .blur(radius: 0.2)
                            }
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 15, style: .continuous)
                                .strokeBorder(
                                    (self.tint ?? .white).opacity(
                                        self.isActive
                                            ? 0.34
                                            : (self.contrast == .increased ? 0.4 : (self.brighten ? 0.22 : 0.16))
                                    ),
                                    lineWidth: self.contrast == .increased ? 1.0 : (self.isActive ? 0.8 : 0.6))
                        }
                        .shadow(
                            color: (self.isActive ? (self.tint ?? .black) : .black).opacity(self.isActive ? 0.22 : 0.14),
                            radius: self.isActive ? 14 : 10,
                            y: self.isActive ? 6 : 4)
                }
                .contentShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.accessibilityLabel)
    }
}
