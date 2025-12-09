import AppKit
import SwiftUI

struct GeneralSettings: View {
    @ObservedObject var state: AppState
    @ObservedObject private var healthStore = HealthStore.shared
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @State private var relayStatus: RelayEnvironmentStatus = .checking
    @State private var relayInstallMessage: String?
    @State private var relayInstalling = false
    @State private var remoteStatus: RemoteStatus = .idle
    @State private var showRemoteAdvanced = false
    private let isPreview = ProcessInfo.processInfo.isPreview

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 18) {
                if !self.state.onboardingSeen {
                    Text("Complete onboarding to finish setup")
                        .font(.callout.weight(.semibold))
                        .foregroundColor(.accentColor)
                        .padding(.bottom, 2)
                }

                VStack(alignment: .leading, spacing: 12) {
                    SettingsToggleRow(
                        title: "Clawdis active",
                        subtitle: "Pause to stop Clawdis background helpers and notifications.",
                        binding: self.activeBinding)

                    self.connectionSection

                    SettingsToggleRow(
                        title: "Launch at login",
                        subtitle: "Automatically start Clawdis after you sign in.",
                        binding: self.$state.launchAtLogin)

                    SettingsToggleRow(
                        title: "Show Dock icon",
                        subtitle: "Keep Clawdis visible in the Dock instead of menu-bar-only mode.",
                        binding: self.$state.showDockIcon)

                    SettingsToggleRow(
                        title: "Play menu bar icon animations",
                        subtitle: "Enable idle blinks and wiggles on the status icon.",
                        binding: self.$state.iconAnimationsEnabled)

                    SettingsToggleRow(
                        title: "Enable debug tools",
                        subtitle: "Show the Debug tab with development utilities.",
                        binding: self.$state.debugPaneEnabled)
                }

                Spacer(minLength: 12)
                HStack {
                    Spacer()
                    Button("Quit Clawdis") { NSApp.terminate(nil) }
                        .buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 22)
            .padding(.bottom, 16)
        }
        .onAppear {
            guard !self.isPreview else { return }
            self.refreshCLIStatus()
            self.refreshRelayStatus()
        }
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !self.state.isPaused },
            set: { self.state.isPaused = !$0 })
    }

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Clawdis runs")
                .font(.title3.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)

            Picker("", selection: self.$state.connectionMode) {
                Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                Text("Remote over SSH").tag(AppState.ConnectionMode.remote)
            }
            .pickerStyle(.segmented)
            .frame(width: 380, alignment: .leading)

            if self.state.connectionMode == .local {
                self.relayInstallerCard
                self.healthRow
            }

            if self.state.connectionMode == .remote {
                self.remoteCard
            }
        }
    }

    private var remoteCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text("SSH")
                    .font(.callout.weight(.semibold))
                    .frame(width: 48, alignment: .leading)
                TextField("user@host[:22]", text: self.$state.remoteTarget)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 280)
            }

            DisclosureGroup(isExpanded: self.$showRemoteAdvanced) {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Identity file") {
                        TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 280)
                    }
                    LabeledContent("Project root") {
                        TextField("/home/you/Projects/clawdis", text: self.$state.remoteProjectRoot)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 280)
                    }
                }
                .padding(.top, 4)
            } label: {
                Text("Advanced")
                    .font(.callout.weight(.semibold))
            }

            HStack(spacing: 10) {
                Button {
                    Task { await self.testRemote() }
                } label: {
                    if self.remoteStatus == .checking {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Test remote")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.remoteStatus == .checking || self.state.remoteTarget
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                switch self.remoteStatus {
                case .idle:
                    EmptyView()
                case .checking:
                    Text("Checking…").font(.caption).foregroundStyle(.secondary)
                case .ok:
                    Label("Ready", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                case let .failed(message):
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            // Diagnostics
            VStack(alignment: .leading, spacing: 4) {
                Text("Control channel")
                    .font(.caption.weight(.semibold))
                Text(self.controlStatusLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let ping = ControlChannel.shared.lastPingMs {
                    Text("Last ping: \(Int(ping)) ms")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let hb = HeartbeatStore.shared.lastEvent {
                    let ageText = age(from: Date(timeIntervalSince1970: hb.ts / 1000))
                    Text("Last heartbeat: \(hb.status) · \(ageText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Tip: enable Tailscale for stable remote access.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .transition(.opacity)
    }

    private var controlStatusLine: String {
        switch ControlChannel.shared.state {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .disconnected: "Disconnected"
        case let .degraded(msg): "Degraded: \(msg)"
        }
    }

    private var cliInstaller: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    Task { await self.installCLI() }
                } label: {
                    if self.isInstallingCLI {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(self.cliInstalled ? "Reinstall CLI helper" : "Install CLI helper")
                    }
                }
                .disabled(self.isInstallingCLI)

                if self.isInstallingCLI {
                    Text("Working...")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else if self.cliInstalled {
                    Label("Installed", systemImage: "checkmark.circle.fill")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Not installed")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }

            if let status = cliStatus {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else if let installLocation = self.cliInstallLocation {
                Text("Found at \(installLocation)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                Text("Symlink \"clawdis-mac\" into /usr/local/bin and /opt/homebrew/bin for scripts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private var relayInstallerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(self.relayStatusColor)
                    .frame(width: 10, height: 10)
                Text(self.relayStatus.message)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let relayVersion = self.relayStatus.relayVersion,
               let required = self.relayStatus.requiredRelay,
               relayVersion != required
            {
                Text("Installed: \(relayVersion) · Required: \(required)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let relayVersion = self.relayStatus.relayVersion {
                Text("Relay \(relayVersion) detected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let node = self.relayStatus.nodeVersion {
                Text("Node \(node)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button {
                    Task { await self.installRelay() }
                } label: {
                    if self.relayInstalling {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Install/Update relay")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.relayInstalling)

                Button("Recheck") { self.refreshRelayStatus() }
                    .buttonStyle(.bordered)
                    .disabled(self.relayInstalling)
            }

            Text(self
                .relayInstallMessage ??
                "Installs the global \"clawdis\" package and expects the gateway on port 18789.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
    }

    private func installCLI() async {
        guard !self.isInstallingCLI else { return }
        self.isInstallingCLI = true
        defer { isInstallingCLI = false }
        await CLIInstaller.install { status in
            await MainActor.run {
                self.cliStatus = status
                self.refreshCLIStatus()
            }
        }
    }

    private func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    private func refreshRelayStatus() {
        self.relayStatus = RelayEnvironment.check()
    }

    private func installRelay() async {
        guard !self.relayInstalling else { return }
        self.relayInstalling = true
        defer { self.relayInstalling = false }
        self.relayInstallMessage = nil
        let expected = RelayEnvironment.expectedRelayVersion()
        await RelayEnvironment.installGlobal(version: expected) { message in
            Task { @MainActor in self.relayInstallMessage = message }
        }
        self.refreshRelayStatus()
    }

    private var relayStatusColor: Color {
        switch self.relayStatus.kind {
        case .ok: .green
        case .checking: .secondary
        case .missingNode, .missingRelay, .incompatible, .error: .orange
        }
    }

    private var healthCard: some View {
        let snapshot = self.healthStore.snapshot
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.healthStore.state.tint)
                    .frame(width: 10, height: 10)
                Text(self.healthStore.summaryLine)
                    .font(.callout.weight(.semibold))
            }

            if let snap = snapshot {
                Text("Linked auth age: \(healthAgeString(snap.web.authAgeMs))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Session store: \(snap.sessions.path) (\(snap.sessions.count) entries)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let recent = snap.sessions.recent.first {
                    let lastActivity = recent.updatedAt != nil
                        ? relativeAge(from: Date(timeIntervalSince1970: (recent.updatedAt ?? 0) / 1000))
                        : "unknown"
                    Text("Last activity: \(recent.key) \(lastActivity)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text("Last check: \(relativeAge(from: self.healthStore.lastSuccess))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let error = self.healthStore.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Text("Health check pending…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Button {
                    Task { await self.healthStore.refresh(onDemand: true) }
                } label: {
                    if self.healthStore.isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Run Health Check", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(self.healthStore.isRefreshing)

                Divider().frame(height: 18)

                Button {
                    self.revealLogs()
                } label: {
                    Label("Reveal Logs", systemImage: "doc.text.magnifyingglass")
                }
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
    }
}

private enum RemoteStatus: Equatable {
    case idle
    case checking
    case ok
    case failed(String)
}

extension GeneralSettings {
    private var healthRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Circle()
                    .fill(self.healthStore.state.tint)
                    .frame(width: 10, height: 10)
                Text(self.healthStore.summaryLine)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let detail = self.healthStore.detailLine {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button("Retry now") {
                    Task { await HealthStore.shared.refresh(onDemand: true) }
                }
                .disabled(self.healthStore.isRefreshing)

                Button("Open logs") { self.revealLogs() }
                    .buttonStyle(.link)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
    }

    @MainActor
    private func testRemote() async {
        self.remoteStatus = .checking
        let settings = CommandResolver.connectionSettings()
        guard !settings.target.isEmpty else {
            self.remoteStatus = .failed("Set an SSH target first")
            return
        }

        // Step 1: basic SSH reachability check
        let sshResult = await ShellExecutor.run(
            command: Self.sshCheckCommand(target: settings.target, identity: settings.identity),
            cwd: nil,
            env: nil,
            timeout: 8)

        guard sshResult.ok else {
            let msg = sshResult.message ?? "SSH check failed"
            self.remoteStatus = .failed(msg)
            return
        }

        // Step 2: control channel health over tunnel
        let originalMode = AppStateStore.shared.connectionMode
        do {
            try await ControlChannel.shared.configure(mode: .remote(
                target: settings.target,
                identity: settings.identity))
            let data = try await ControlChannel.shared.health(timeout: 10)
            if decodeHealthSnapshot(from: data) != nil {
                self.remoteStatus = .ok
            } else {
                self.remoteStatus = .failed("Control channel returned invalid health JSON")
            }
        } catch {
            self.remoteStatus = .failed(error.localizedDescription)
        }

        // Restore original mode if we temporarily switched
        if originalMode != .remote {
            let restoreMode: ControlChannel.Mode = .local
            try? await ControlChannel.shared.configure(mode: restoreMode)
        }
    }

    private static func sshCheckCommand(target: String, identity: String) -> [String] {
        var args: [String] = ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]
        if !identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["-i", identity])
        }
        args.append(target)
        args.append("echo ok")
        return args
    }

    private func revealLogs() {
        let path = URL(fileURLWithPath: "/tmp/clawdis/clawdis.log")
        if FileManager.default.fileExists(atPath: path.path) {
            NSWorkspace.shared.selectFile(path.path, inFileViewerRootedAtPath: path.deletingLastPathComponent().path)
            return
        }

        let alert = NSAlert()
        alert.messageText = "Log file not found"
        alert.informativeText = "Expected log at \(path.path). Run a health check or generate activity first."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }
}

private func healthAgeString(_ ms: Double?) -> String {
    guard let ms else { return "unknown" }
    return msToAge(ms)
}

#if DEBUG
struct GeneralSettings_Previews: PreviewProvider {
    static var previews: some View {
        GeneralSettings(state: .preview)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
