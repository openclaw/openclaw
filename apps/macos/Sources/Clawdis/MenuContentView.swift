import AppKit
import AVFoundation
import Foundation
import SwiftUI

/// Menu contents for the Clawdis menu bar extra.
struct MenuContent: View {
    @ObservedObject var state: AppState
    let updater: UpdaterProviding?
    @ObservedObject private var relayManager = RelayProcessManager.shared
    @ObservedObject private var healthStore = HealthStore.shared
    @ObservedObject private var heartbeatStore = HeartbeatStore.shared
    @ObservedObject private var controlChannel = ControlChannel.shared
    @ObservedObject private var activityStore = WorkActivityStore.shared
    @Environment(\.openSettings) private var openSettings
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) {
                let label = self.state.connectionMode == .remote ? "Remote Clawdis Active" : "Clawdis Active"
                Text(label)
            }
            self.statusRow
            Toggle(isOn: self.heartbeatsBinding) { Text("Send Heartbeats") }
            self.heartbeatStatusRow
            Toggle(isOn: self.voiceWakeBinding) { Text("Voice Wake") }
                .disabled(!voiceWakeSupported)
                .opacity(voiceWakeSupported ? 1 : 0.5)
            if self.showVoiceWakeMicPicker {
                self.voiceWakeMicMenu
            }
            if AppStateStore.webChatEnabled {
                Button("Open Chat") { WebChatManager.shared.show(sessionKey: self.primarySessionKey()) }
            }
            Divider()
            Button("Settings…") { self.open(tab: .general) }
                .keyboardShortcut(",", modifiers: [.command])
            Button("About Clawdis") { self.open(tab: .about) }
            if let updater, updater.isAvailable {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .task(id: self.state.swabbleEnabled) {
            if self.state.swabbleEnabled {
                await self.loadMicrophones(force: true)
            }
        }
        .task {
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)
        }
        .onChange(of: self.state.voicePushToTalkEnabled) { _, enabled in
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && enabled)
        }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var statusRow: some View {
        if let activity = self.activityStore.current {
            let color: Color = activity.role == .main ? .accentColor : .gray
            let roleLabel = activity.role == .main ? "Main" : "Other"
            let text = "\(roleLabel) · \(activity.label)"
            return HStack(spacing: 8) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(text)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.vertical, 4)
        } else {
            let health = self.healthStore.state
            let isRefreshing = self.healthStore.isRefreshing
            let lastAge = self.healthStore.lastSuccess.map { age(from: $0) }

            let label: String
            let color: Color

            if isRefreshing {
                label = "Health check running…"
                color = health.tint
            } else {
                switch health {
                case .ok:
                    let ageText = lastAge.map { " · checked \($0)" } ?? ""
                    label = "Health ok\(ageText)"
                    color = .green
                case .linkingNeeded:
                    label = "Health: login required"
                    color = .red
                case let .degraded(reason):
                    let ageText = lastAge.map { " · checked \($0)" } ?? ""
                    label = "Health degraded: \(reason)\(ageText)"
                    color = .orange
                case .unknown:
                    label = "Health pending"
                    color = .secondary
                }
            }

            return HStack(spacing: 8) {
                Circle()
                    .fill(color)
                    .frame(width: 8, height: 8)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
            }
            .padding(.vertical, 4)
        }
    }

    private var heartbeatStatusRow: some View {
        let label: String
        let color: Color

        if case .degraded = self.controlChannel.state {
            label = "Control channel disconnected"
            color = .red
        } else if let evt = self.heartbeatStore.lastEvent {
            let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
            switch evt.status {
            case "sent":
                label = "Last heartbeat sent · \(ageText)"
                color = .blue
            case "ok-empty", "ok-token":
                label = "Heartbeat ok · \(ageText)"
                color = .green
            case "skipped":
                label = "Heartbeat skipped · \(ageText)"
                color = .secondary
            case "failed":
                label = "Heartbeat failed · \(ageText)"
                color = .red
            default:
                label = "Heartbeat · \(ageText)"
                color = .secondary
            }
        } else {
            label = "No heartbeat yet"
            color = .secondary
        }

        return HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 2)
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

    private func primarySessionKey() -> String {
        // Prefer canonical main session; fall back to most recent.
        let storePath = SessionLoader.defaultStorePath
        if let data = try? Data(contentsOf: URL(fileURLWithPath: storePath)),
           let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        {
            if decoded.keys.contains("main") { return "main" }

            let sorted = decoded.sorted { a, b -> Bool in
                let lhs = a.value.updatedAt ?? 0
                let rhs = b.value.updatedAt ?? 0
                return lhs > rhs
            }
            if let first = sorted.first { return first.key }
        }
        return "+1003"
    }

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }
}
