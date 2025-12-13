import AppKit
import AVFoundation
import Foundation
import SwiftUI

/// Menu contents for the Clawdis menu bar extra.
struct MenuContent: View {
    @ObservedObject var state: AppState
    let updater: UpdaterProviding?
    @ObservedObject private var gatewayManager = GatewayProcessManager.shared
    @ObservedObject private var healthStore = HealthStore.shared
    @ObservedObject private var heartbeatStore = HeartbeatStore.shared
    @ObservedObject private var controlChannel = ControlChannel.shared
    @ObservedObject private var activityStore = WorkActivityStore.shared
    @Environment(\.openSettings) private var openSettings
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var sessionMenu: [SessionRow] = []
    @State private var browserControlEnabled = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) {
                let label = self.state.connectionMode == .remote ? "Remote Clawdis Active" : "Clawdis Active"
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                    self.statusLine(label: self.healthStatus.label, color: self.healthStatus.color)
                }
            }
            Divider()
            Toggle(isOn: self.heartbeatsBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Send Heartbeats")
                    self.statusLine(label: self.heartbeatStatus.label, color: self.heartbeatStatus.color)
                }
            }
            Toggle(isOn: self.voiceWakeBinding) { Text("Voice Wake") }
                .disabled(!voiceWakeSupported)
                .opacity(voiceWakeSupported ? 1 : 0.5)
            if self.showVoiceWakeMicPicker {
                self.voiceWakeMicMenu
            }
            if AppStateStore.webChatEnabled {
                Button("Open Chat") {
                    WebChatManager.shared.show(sessionKey: WebChatManager.shared.preferredSessionKey())
                }
            }
            Toggle(isOn: Binding(
                get: { self.browserControlEnabled },
                set: { enabled in
                    self.browserControlEnabled = enabled
                    ClawdisConfigFile.setBrowserControlEnabled(enabled)
                })
            ) {
                Text("Browser Control")
            }
            Toggle(isOn: Binding(get: { self.state.canvasEnabled }, set: { self.state.canvasEnabled = $0 })) {
                Text("Allow Canvas")
            }
            .onChange(of: self.state.canvasEnabled) { _, enabled in
                if !enabled {
                    CanvasManager.shared.hideAll()
                }
            }
            Divider()
            Button("Settings…") { self.open(tab: .general) }
                .keyboardShortcut(",", modifiers: [.command])
            Button("About Clawdis") { self.open(tab: .about) }
            if let updater, updater.isAvailable {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            if self.state.debugPaneEnabled {
                Menu("Debug") {
                    Menu {
                        ForEach(self.sessionMenu) { row in
                            Menu(row.key) {
                                Menu("Thinking") {
                                    ForEach(["low", "medium", "high", "default"], id: \.self) { level in
                                        let normalized = level == "default" ? nil : level
                                        Button {
                                            Task {
                                                try? await DebugActions.updateSession(
                                                    key: row.key,
                                                    thinking: normalized,
                                                    verbose: row.verboseLevel)
                                                await self.reloadSessionMenu()
                                            }
                                        } label: {
                                            Label(
                                                level.capitalized,
                                                systemImage: row.thinkingLevel == normalized ? "checkmark" : "")
                                        }
                                    }
                                }
                                Menu("Verbose") {
                                    ForEach(["on", "off", "default"], id: \.self) { level in
                                        let normalized = level == "default" ? nil : level
                                        Button {
                                            Task {
                                                try? await DebugActions.updateSession(
                                                    key: row.key,
                                                    thinking: row.thinkingLevel,
                                                    verbose: normalized)
                                                await self.reloadSessionMenu()
                                            }
                                        } label: {
                                            Label(
                                                level.capitalized,
                                                systemImage: row.verboseLevel == normalized ? "checkmark" : "")
                                        }
                                    }
                                }
                                Button {
                                    DebugActions.openSessionStoreInCode()
                                } label: {
                                    Label("Open Session Log", systemImage: "doc.text")
                                }
                            }
                        }
                        Divider()
                    } label: {
                        Label("Sessions", systemImage: "clock.arrow.circlepath")
                    }
                    Divider()
                    Button {
                        DebugActions.openConfigFolder()
                    } label: {
                        Label("Open Config Folder", systemImage: "folder")
                    }
                    Button {
                        Task { await DebugActions.runHealthCheckNow() }
                    } label: {
                        Label("Run Health Check Now", systemImage: "stethoscope")
                    }
                    Button {
                        Task { _ = await DebugActions.sendTestHeartbeat() }
                    } label: {
                        Label("Send Test Heartbeat", systemImage: "waveform.path.ecg")
                    }
                    Button {
                        Task { _ = await DebugActions.toggleVerboseLoggingMain() }
                    } label: {
                        Label(
                            DebugActions.verboseLoggingEnabledMain
                                ? "Verbose Logging (Main): On"
                                : "Verbose Logging (Main): Off",
                            systemImage: "text.alignleft")
                    }
                    Button {
                        DebugActions.openSessionStore()
                    } label: {
                        Label("Open Session Store", systemImage: "externaldrive")
                    }
                    Divider()
                    Button {
                        DebugActions.openAgentEventsWindow()
                    } label: {
                        Label("Open Agent Events…", systemImage: "bolt.horizontal.circle")
                    }
                    Button {
                        DebugActions.openLog()
                    } label: {
                        Label("Open Log", systemImage: "doc.text.magnifyingglass")
                    }
                    Button {
                        Task { _ = await DebugActions.sendDebugVoice() }
                    } label: {
                        Label("Send Debug Voice Text", systemImage: "waveform.circle")
                    }
                    Button {
                        Task { await DebugActions.sendTestNotification() }
                    } label: {
                        Label("Send Test Notification", systemImage: "bell")
                    }
                    Button {
                        Task { await DebugActions.openChatInBrowser() }
                    } label: {
                        Label("Open Chat in Browser…", systemImage: "safari")
                    }
                    Divider()
                    Button {
                        DebugActions.restartGateway()
                    } label: {
                        Label("Restart Gateway", systemImage: "arrow.clockwise")
                    }
                    Button {
                        DebugActions.restartApp()
                    } label: {
                        Label("Restart App", systemImage: "arrow.triangle.2.circlepath")
                    }
                }
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .task(id: self.state.swabbleEnabled) {
            if self.state.swabbleEnabled {
                await self.loadMicrophones(force: true)
            }
        }
        .task {
            await self.reloadSessionMenu()
        }
        .task {
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)
        }
        .onChange(of: self.state.voicePushToTalkEnabled) { _, enabled in
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && enabled)
        }
        .onAppear {
            self.browserControlEnabled = ClawdisConfigFile.browserControlEnabled()
        }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var healthStatus: (label: String, color: Color) {
        if let activity = self.activityStore.current {
            let color: Color = activity.role == .main ? .accentColor : .gray
            let roleLabel = activity.role == .main ? "Main" : "Other"
            let text = "\(roleLabel) · \(activity.label)"
            return (text, color)
        }

        let health = self.healthStore.state
        let isRefreshing = self.healthStore.isRefreshing
        let lastAge = self.healthStore.lastSuccess.map { age(from: $0) }

        if isRefreshing {
            return ("Health check running…", health.tint)
        }

        switch health {
        case .ok:
            let ageText = lastAge.map { " · checked \($0)" } ?? ""
            return ("Health ok\(ageText)", .green)
        case .linkingNeeded:
            return ("Health: login required", .red)
        case let .degraded(reason):
            let detail = HealthStore.shared.degradedSummary ?? reason
            let ageText = lastAge.map { " · checked \($0)" } ?? ""
            return ("\(detail)\(ageText)", .orange)
        case .unknown:
            return ("Health pending", .secondary)
        }
    }

    private var heartbeatStatus: (label: String, color: Color) {
        if case .degraded = self.controlChannel.state {
            return ("Control channel disconnected", .red)
        } else if let evt = self.heartbeatStore.lastEvent {
            let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
            switch evt.status {
            case "sent":
                return ("Last heartbeat sent · \(ageText)", .blue)
            case "ok-empty", "ok-token":
                return ("Heartbeat ok · \(ageText)", .green)
            case "skipped":
                return ("Heartbeat skipped · \(ageText)", .secondary)
            case "failed":
                return ("Heartbeat failed · \(ageText)", .red)
            default:
                return ("Heartbeat · \(ageText)", .secondary)
            }
        } else {
            return ("No heartbeat yet", .secondary)
        }
    }

    @ViewBuilder
    private func statusLine(label: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 2)
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private var heartbeatsBinding: Binding<Bool> {
        Binding(get: { self.state.heartbeatsEnabled }, set: { self.state.heartbeatsEnabled = $0 })
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
    }

    private var showVoiceWakeMicPicker: Bool {
        voiceWakeSupported && self.state.swabbleEnabled
    }

    private var voiceWakeMicMenu: some View {
        Menu {
            self.microphoneMenuItems

            if self.loadingMics {
                Divider()
                Label("Refreshing microphones…", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.titleOnly)
                    .foregroundStyle(.secondary)
                    .disabled(true)
            }
        } label: {
            HStack {
                Text("Microphone")
                Spacer()
                Text(self.selectedMicLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .task { await self.loadMicrophones() }
    }

    private var selectedMicLabel: String {
        if self.state.voiceWakeMicID.isEmpty { return self.defaultMicLabel }
        if let match = self.availableMics.first(where: { $0.uid == self.state.voiceWakeMicID }) {
            return match.name
        }
        return "Unavailable"
    }

    private var microphoneMenuItems: some View {
        Group {
            Button {
                self.state.voiceWakeMicID = ""
            } label: {
                Label(self.defaultMicLabel, systemImage: self.state.voiceWakeMicID.isEmpty ? "checkmark" : "")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)

            ForEach(self.availableMics) { mic in
                Button {
                    self.state.voiceWakeMicID = mic.uid
                } label: {
                    Label(mic.name, systemImage: self.state.voiceWakeMicID == mic.uid ? "checkmark" : "")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var defaultMicLabel: String {
        if let host = Host.current().localizedName, !host.isEmpty {
            return "Auto-detect (\(host))"
        }
        return "System default"
    }

    @MainActor
    private func reloadSessionMenu() async {
        self.sessionMenu = await DebugActions.recentSessions()
    }

    @MainActor
    private func loadMicrophones(force: Bool = false) async {
        guard self.showVoiceWakeMicPicker else {
            self.availableMics = []
            self.loadingMics = false
            return
        }
        if !force, !self.availableMics.isEmpty { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        self.availableMics = discovery.devices
            .sorted { lhs, rhs in
                lhs.localizedName.localizedCaseInsensitiveCompare(rhs.localizedName) == .orderedAscending
            }
            .map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.loadingMics = false
    }

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }
}
