import SwiftUI
import UIKit

struct RootCanvas: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @State private var presentedSheet: PresentedSheet?
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?

    private enum PresentedSheet: Identifiable {
        case settings
        case chat

        var id: Int {
            switch self {
            case .settings: 0
            case .chat: 1
            }
        }
    }

    var body: some View {
        ZStack {
            CanvasContent(
                systemColorScheme: self.systemColorScheme,
                bridgeStatus: self.bridgeStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                voiceWakeToastText: self.voiceWakeToastText,
                openChat: {
                    self.presentedSheet = .chat
                },
                openSettings: {
                    self.presentedSheet = .settings
                })
                .preferredColorScheme(.dark)
        }
        .sheet(item: self.$presentedSheet) { sheet in
            switch sheet {
            case .settings:
                SettingsTab()
            case .chat:
                ChatSheet(bridge: self.appModel.bridgeSession)
            }
        }
        .onAppear { self.updateIdleTimer() }
        .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
        .onChange(of: self.scenePhase) { _, _ in self.updateIdleTimer() }
        .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
            guard let newValue else { return }
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            self.toastDismissTask?.cancel()
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                self.voiceWakeToastText = trimmed
            }

            self.toastDismissTask = Task {
                try? await Task.sleep(nanoseconds: 2_300_000_000)
                await MainActor.run {
                    withAnimation(.easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            self.toastDismissTask?.cancel()
            self.toastDismissTask = nil
        }
    }

    private var bridgeStatus: StatusPill.BridgeState {
        if self.appModel.bridgeServerName != nil { return .connected }

        let text = self.appModel.bridgeStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.localizedCaseInsensitiveContains("connecting") ||
            text.localizedCaseInsensitiveContains("reconnecting")
        {
            return .connecting
        }

        if text.localizedCaseInsensitiveContains("error") {
            return .error
        }

        return .disconnected
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = (self.scenePhase == .active && self.preventSleep)
    }
}

private struct CanvasContent: View {
    var systemColorScheme: ColorScheme
    var bridgeStatus: StatusPill.BridgeState
    var voiceWakeEnabled: Bool
    var voiceWakeToastText: String?
    var openChat: () -> Void
    var openSettings: () -> Void

    private var brightenButtons: Bool { self.systemColorScheme == .light }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ScreenTab()

            VStack(spacing: 10) {
                OverlayButton(systemImage: "text.bubble.fill", brighten: self.brightenButtons) {
                    self.openChat()
                }
                .accessibilityLabel("Chat")

                OverlayButton(systemImage: "gearshape.fill", brighten: self.brightenButtons) {
                    self.openSettings()
                }
                .accessibilityLabel("Settings")
            }
            .padding(.top, 10)
            .padding(.trailing, 10)
        }
        .overlay(alignment: .topLeading) {
            StatusPill(
                bridge: self.bridgeStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                brighten: self.brightenButtons,
                onTap: {
                    self.openSettings()
                })
                .padding(.leading, 10)
                .safeAreaPadding(.top, 10)
        }
        .overlay(alignment: .topLeading) {
            if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                VoiceWakeToast(
                    command: voiceWakeToastText,
                    brighten: self.brightenButtons)
                    .padding(.leading, 10)
                    .safeAreaPadding(.top, 58)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }
}

private struct OverlayButton: View {
    let systemImage: String
    let brighten: Bool
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .padding(10)
                .background {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            .white.opacity(self.brighten ? 0.26 : 0.18),
                                            .white.opacity(self.brighten ? 0.08 : 0.04),
                                            .clear,
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing))
                                .blendMode(.overlay)
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(.white.opacity(self.brighten ? 0.24 : 0.18), lineWidth: 0.5)
                        }
                        .shadow(color: .black.opacity(0.35), radius: 12, y: 6)
                }
        }
        .buttonStyle(.plain)
    }
}
