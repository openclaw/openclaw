import AppKit
import SwiftUI

struct GeneralSettings: View {
    @ObservedObject var state: AppState
    @ObservedObject private var healthStore = HealthStore.shared
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?
    @State private var cliInstalled = false
    @State private var cliInstallLocation: String?

    var body: some View {
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

            VStack(alignment: .leading, spacing: 8) {
                Text("Health")
                    .font(.callout.weight(.semibold))
                self.healthCard
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("CLI helper")
                    .font(.callout.weight(.semibold))
                self.cliInstaller
            }

            Spacer()
            HStack {
                Spacer()
                Button("Quit Clawdis") { NSApp.terminate(nil) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22)
        .onAppear { self.refreshCLIStatus() }
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !self.state.isPaused },
            set: { self.state.isPaused = !$0 })
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
            }
            Text("Symlink \"clawdis-mac\" into /usr/local/bin and /opt/homebrew/bin for scripts.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.leading, 2)
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
                    Text("Last activity: \(recent.key) \(recent.updatedAt != nil ? relativeAge(from: Date(timeIntervalSince1970: (recent.updatedAt ?? 0) / 1000)) : "unknown")")
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

private extension GeneralSettings {
    func revealLogs() {
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
