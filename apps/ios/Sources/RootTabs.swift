import SwiftUI

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @State private var selectedTab: Int = 0
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var showGatewayActions: Bool = false

    var body: some View {
        TabView(selection: self.$selectedTab) {
            ScreenTab()
                .tabItem { Label("Screen", systemImage: "rectangle.and.hand.point.up.left") }
                .tag(0)

            VoiceTab()
                .tabItem { Label("Voice", systemImage: "mic") }
                .tag(1)

            SettingsTab()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(2)
        }
        .overlay(alignment: .topLeading) {
            StatusPill(
                gateway: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                activity: self.statusActivity,
                onTap: {
                    if self.gatewayStatus == .connected {
                        self.showGatewayActions = true
                    } else {
                        self.selectedTab = 2
                    }
                })
                .padding(.leading, 10)
                .safeAreaPadding(.top, 10)
        }
        .overlay(alignment: .topLeading) {
            if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                VoiceWakeToast(command: voiceWakeToastText)
                    .padding(.leading, 10)
                    .safeAreaPadding(.top, 58)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
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
            self.toastDismissTask?.cancel()
            self.toastDismissTask = nil
        }
        .confirmationDialog(
            "Gateway",
            isPresented: self.$showGatewayActions,
            titleVisibility: .visible)
        {
            Button("Disconnect", role: .destructive) {
                self.appModel.disconnectGateway()
            }
            Button("Open Settings") {
                self.selectedTab = 2
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Disconnect from the gateway?")
        }
    }

    private var gatewayStatus: StatusPill.GatewayState {
        if self.appModel.gatewayServerName != nil { return .connected }

        let text = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
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

    private var statusActivity: StatusPill.Activity? {
        // Keep the top pill consistent across tabs (camera + voice wake + pairing states).
        if self.appModel.isBackgrounded {
            return StatusPill.Activity(
                title: "Foreground required",
                systemImage: "exclamationmark.triangle.fill",
                tint: .orange)
        }

        let gatewayStatus = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let gatewayLower = gatewayStatus.lowercased()
        if gatewayLower.contains("repair") {
            return StatusPill.Activity(title: "Repairing…", systemImage: "wrench.and.screwdriver", tint: .orange)
        }
        if gatewayLower.contains("approval") || gatewayLower.contains("pairing") {
            return StatusPill.Activity(title: "Approval pending", systemImage: "person.crop.circle.badge.clock")
        }
        // Avoid duplicating the primary gateway status ("Connecting…") in the activity slot.

        if self.appModel.screenRecordActive {
            return StatusPill.Activity(title: "Recording screen…", systemImage: "record.circle.fill", tint: .red)
        }

        if let cameraHUDText = self.appModel.cameraHUDText,
           let cameraHUDKind = self.appModel.cameraHUDKind,
           !cameraHUDText.isEmpty
        {
            let systemImage: String
            let tint: Color?
            switch cameraHUDKind {
            case .photo:
                systemImage = "camera.fill"
                tint = nil
            case .recording:
                systemImage = "video.fill"
                tint = .red
            case .success:
                systemImage = "checkmark.circle.fill"
                tint = .green
            case .error:
                systemImage = "exclamationmark.triangle.fill"
                tint = .red
            }
            return StatusPill.Activity(title: cameraHUDText, systemImage: systemImage, tint: tint)
        }

        if self.voiceWakeEnabled {
            let voiceStatus = self.appModel.voiceWake.statusText
            if voiceStatus.localizedCaseInsensitiveContains("microphone permission") {
                return StatusPill.Activity(title: "Mic permission", systemImage: "mic.slash", tint: .orange)
            }
            if voiceStatus == "Paused" {
                // Talk mode intentionally pauses voice wake to release the mic. Don't spam the HUD for that case.
                if self.appModel.talkMode.isEnabled {
                    return nil
                }
                let suffix = self.appModel.isBackgrounded ? " (background)" : ""
                return StatusPill.Activity(title: "Voice Wake paused\(suffix)", systemImage: "pause.circle.fill")
            }
        }

        return nil
    }
}
