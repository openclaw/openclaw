import SwiftUI

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @State private var selectedTab: Int = 0
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var showGatewayActions: Bool = false
    @State private var showGatewayProblemDetails: Bool = false

    var body: some View {
        TabView(selection: self.$selectedTab) {
            BuddyModeView(snapshot: self.buddySnapshot)
                .tabItem { Label("Nemo", systemImage: "face.smiling") }
                .tag(0)

            ScreenTab()
                .tabItem { Label("Screen", systemImage: "rectangle.and.hand.point.up.left") }
                .tag(1)

            VoiceTab()
                .tabItem { Label("Voice", systemImage: "mic") }
                .tag(2)

            SettingsTab()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(3)
        }
        .overlay(alignment: .topLeading) {
            StatusPill(
                gateway: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                activity: self.statusActivity,
                onTap: {
                    if self.gatewayStatus == .connected {
                        self.showGatewayActions = true
                    } else if self.appModel.lastGatewayProblem != nil {
                        self.showGatewayProblemDetails = true
                    } else {
                        self.selectedTab = 2
                    }
                })
                .padding(.leading, 10)
                .safeAreaPadding(.top, 10)
        }
        .overlay(alignment: .top) {
            if let gatewayProblem = self.appModel.lastGatewayProblem,
               self.gatewayStatus != .connected
            {
                GatewayProblemBanner(
                    problem: gatewayProblem,
                    primaryActionTitle: "Open Settings",
                    onPrimaryAction: {
                        self.selectedTab = 2
                    },
                    onShowDetails: {
                        self.showGatewayProblemDetails = true
                    })
                    .padding(.horizontal, 12)
                    .safeAreaPadding(.top, 10)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .overlay(alignment: .topLeading) {
            if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                VoiceWakeToast(command: voiceWakeToastText)
                    .padding(.leading, 10)
                    .safeAreaPadding(.top, self.appModel.lastGatewayProblem == nil ? 58 : 132)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
            guard let newValue else { return }
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            self.toastDismissTask?.cancel()
            withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                self.voiceWakeToastText = trimmed
            }

            self.toastDismissTask = Task {
                try? await Task.sleep(nanoseconds: 2_300_000_000)
                await MainActor.run {
                    withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
        }
        .onDisappear {
            self.toastDismissTask?.cancel()
            self.toastDismissTask = nil
        }
        .gatewayActionsDialog(
            isPresented: self.$showGatewayActions,
            onDisconnect: { self.appModel.disconnectGateway() },
            onOpenSettings: { self.selectedTab = 2 })
        .sheet(isPresented: self.$showGatewayProblemDetails) {
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                GatewayProblemDetailsSheet(
                    problem: gatewayProblem,
                    primaryActionTitle: "Open Settings",
                    onPrimaryAction: {
                        self.selectedTab = 2
                    })
            }
        }
    }

    private var gatewayStatus: StatusPill.GatewayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private var statusActivity: StatusPill.Activity? {
        StatusActivityBuilder.build(
            appModel: self.appModel,
            voiceWakeEnabled: self.voiceWakeEnabled,
            cameraHUDText: self.appModel.cameraHUDText,
            cameraHUDKind: self.appModel.cameraHUDKind)
    }

    private var buddySnapshot: BuddySnapshot {
        BuddySnapshotBuilder.build(
            connected: self.gatewayStatus == .connected,
            recording: self.voiceWake.isListening,
            speaking: self.appModel.talkMode.isSpeaking,
            thinking: false,
            visionScanning: self.appModel.cameraHUDText != nil,
            assistantMessage: self.talkStatusMessage)
    }

    private var talkStatusMessage: String? {
        let status = self.appModel.talkMode.statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !status.isEmpty, status != "Off" else { return nil }
        return status
    }
}
