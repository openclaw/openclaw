import AppKit
import SwiftUI

struct GeneralSettings: View {
    @ObservedObject var state: AppState
    @ObservedObject private var healthStore = HealthStore.shared
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?
    @State private var remoteStatus: RemoteStatus = .idle
    @State private var showRemoteAdvanced = false

var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 18) {
                self.connectionSection

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

                    LabeledContent("Default sound") {
                        Picker("Sound", selection: self.$state.defaultSound) {
                            Text("None").tag("")
                            Text("Glass").tag("Glass")
                            Text("Basso").tag("Basso")
                            Text("Ping").tag("Ping")
                        }
                        .labelsHidden()
                        .frame(width: 140)
                    }
                }

                self.healthRow

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
        .onAppear { self.refreshCLIStatus() }
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !self.state.isPaused },
            set: { self.state.isPaused = !$0 })
    }

    private var connectionSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Clawdis runs", selection: self.$state.connectionMode) {
                Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                Text("Remote over SSH").tag(AppState.ConnectionMode.remote)
            }
            .pickerStyle(.segmented)
            .frame(width: 360)

            if self.state.connectionMode == .remote {
                self.remoteCard
            }

            self.healthRow
        }
    }

    private var remoteCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Text("SSH")
                    .font(.callout.weight(.semibold))
                    .frame(width: 44, alignment: .leading)
                TextField("user@host[:22]", text: self.$state.remoteTarget)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 260)
            }

            DisclosureGroup(isExpanded: self.$showRemoteAdvanced) {
                VStack(alignment: .leading, spacing: 8) {
                    LabeledContent("Identity file") {
                        TextField("/Users/you/.ssh/id_ed25519", text: self.$state.remoteIdentity)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 260)
                    }
                    LabeledContent("Project root") {
                        TextField("/home/you/Projects/clawdis", text: self.$state.remoteProjectRoot)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 260)
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
                .disabled(self.remoteStatus == .checking || self.state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

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

            Text("Tip: use Tailscale so your remote Clawdis stays reachable.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
        .transition(.opacity)
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
                    Text(
                        "Last activity: \(recent.key) \(recent.updatedAt != nil ? relativeAge(from: Date(timeIntervalSince1970: (recent.updatedAt ?? 0) / 1000)) : "unknown")")
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
        HStack(spacing: 10) {
            Circle()
                .fill(self.healthStore.state.tint)
                .frame(width: 10, height: 10)
            Text(self.healthStore.summaryLine)
                .font(.callout)
        }
    }

    @MainActor
    fileprivate func testRemote() async {
        self.remoteStatus = .checking
        let command = CommandResolver.clawdisCommand(subcommand: "status", extraArgs: ["--json"])
        let response = await ShellRunner.run(command: command, cwd: nil, env: nil, timeout: 10)
        if response.ok {
            self.remoteStatus = .ok
        } else {
            let msg = response.message ?? "test failed"
            self.remoteStatus = .failed(msg)
        }
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
