import AppKit
import Observation
import SwiftUI

struct GeneralSettings: View {
    @Bindable var state: AppState
    @AppStorage(cameraEnabledKey) private var cameraEnabled: Bool = false
    private let healthStore = HealthStore.shared
    private let gatewayManager = GatewayProcessManager.shared
    // swiftlint:disable:next inclusive_language
    @State private var masterDiscovery = MasterDiscoveryModel()
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @State private var gatewayStatus: GatewayEnvironmentStatus = .checking
    @State private var gatewayInstallMessage: String?
    @State private var gatewayInstalling = false
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
                        subtitle: "Pause to stop the Clawdis gateway; no messages will be processed.",
                        binding: self.activeBinding)

                    self.connectionSection

                    Divider()

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
                        title: "Allow Canvas",
                        subtitle: "Allow the agent to show and control the Canvas panel.",
                        binding: self.$state.canvasEnabled)

                    SettingsToggleRow(
                        title: "Allow Camera",
                        subtitle: "Allow the agent to capture a photo or short video via the built-in camera.",
                        binding: self.$cameraEnabled)

                    SettingsToggleRow(
                        title: "Enable Peekaboo Bridge",
                        subtitle: "Allow signed tools (e.g. `peekaboo`) to drive UI automation via PeekabooBridge.",
                        binding: self.$state.peekabooBridgeEnabled)

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
            self.refreshGatewayStatus()
        }
        .onChange(of: self.state.canvasEnabled) { _, enabled in
            if !enabled {
                CanvasManager.shared.hideAll()
            }
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
                self.gatewayInstallerCard
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
                    .frame(maxWidth: .infinity)
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
            }

            MasterDiscoveryInlineList(
                discovery: self.masterDiscovery,
                currentTarget: self.state.remoteTarget)
            { master in
                self.applyDiscoveredMaster(master)
            }
            .padding(.leading, 58)

            self.remoteStatusView
                .padding(.leading, 58)

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

            // Diagnostics
            VStack(alignment: .leading, spacing: 4) {
                Text("Control channel")
                    .font(.caption.weight(.semibold))
                if !self.isControlStatusDuplicate {
                    Text(self.controlStatusLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
        .onAppear { self.masterDiscovery.start() }
        .onDisappear { self.masterDiscovery.stop() }
    }

    private var controlStatusLine: String {
        switch ControlChannel.shared.state {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .disconnected: "Disconnected"
        case let .degraded(msg): msg
        }
    }

    @ViewBuilder
    private var remoteStatusView: some View {
        switch self.remoteStatus {
        case .idle:
            EmptyView()
        case .checking:
            Text("Testing…")
                .font(.caption)
                .foregroundStyle(.secondary)
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

    private var isControlStatusDuplicate: Bool {
        guard case let .failed(message) = self.remoteStatus else { return false }
        return message == self.controlStatusLine
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

    private var gatewayInstallerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(self.gatewayStatusColor)
                    .frame(width: 10, height: 10)
                Text(self.gatewayStatus.message)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let gatewayVersion = self.gatewayStatus.gatewayVersion,
               let required = self.gatewayStatus.requiredGateway,
               gatewayVersion != required
            {
                Text("Installed: \(gatewayVersion) · Required: \(required)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let gatewayVersion = self.gatewayStatus.gatewayVersion {
                Text("Gateway \(gatewayVersion) detected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let node = self.gatewayStatus.nodeVersion {
                Text("Node \(node)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if case let .attachedExisting(details) = self.gatewayManager.status {
                Text(details ?? "Using existing gateway instance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let failure = self.gatewayManager.lastFailureReason {
                Text("Last failure: \(failure)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack(spacing: 10) {
                Button {
                    Task { await self.installGateway() }
                } label: {
                    if self.gatewayInstalling {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Enable Gateway daemon")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.gatewayInstalling)

                Button("Recheck") { self.refreshGatewayStatus() }
                    .buttonStyle(.bordered)
                    .disabled(self.gatewayInstalling)
            }

            Text(self
                .gatewayInstallMessage ??
                "Enables the bundled Gateway via launchd (\(gatewayLaunchdLabel)). No Node install required.")
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

    private func refreshGatewayStatus() {
        Task {
            let status = await Task.detached(priority: .utility) {
                GatewayEnvironment.check()
            }.value
            self.gatewayStatus = status
        }
    }

    private func installGateway() async {
        guard !self.gatewayInstalling else { return }
        self.gatewayInstalling = true
        defer { self.gatewayInstalling = false }
        self.gatewayInstallMessage = nil
        let port = GatewayEnvironment.gatewayPort()
        let bundlePath = Bundle.main.bundleURL.path
        let err = await GatewayLaunchAgentManager.set(enabled: true, bundlePath: bundlePath, port: port)
        self.gatewayInstallMessage = err ?? "Gateway enabled and started on port \(port)"
        self.refreshGatewayStatus()
    }

    private var gatewayStatusColor: Color {
        switch self.gatewayStatus.kind {
        case .ok: .green
        case .checking: .secondary
        case .missingNode, .missingGateway, .incompatible, .error: .orange
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
    func testRemote() async {
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
        let target = LogLocator.bestLogFile()

        if let target {
            NSWorkspace.shared.selectFile(
                target.path,
                inFileViewerRootedAtPath: target.deletingLastPathComponent().path)
            return
        }

        let alert = NSAlert()
        alert.messageText = "Log file not found"
        alert.informativeText = """
        Looked for clawdis logs in /tmp/clawdis/.
        Run a health check or send a message to generate activity, then try again.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    // swiftlint:disable:next inclusive_language
    private func applyDiscoveredMaster(_ master: MasterDiscoveryModel.DiscoveredMaster) {
        let host = master.tailnetDns ?? master.lanHost
        guard let host else { return }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if master.sshPort != 22 {
            target += ":\(master.sshPort)"
        }
        self.state.remoteTarget = target
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
