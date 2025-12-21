import SwiftUI

private enum GatewayTailscaleMode: String, CaseIterable, Identifiable {
    case off
    case serve
    case funnel

    var id: String { self.rawValue }

    var label: String {
        switch self {
        case .off: "Off"
        case .serve: "Tailnet (Serve)"
        case .funnel: "Public (Funnel)"
        }
    }

    var description: String {
        switch self {
        case .off:
            "No automatic Tailscale configuration."
        case .serve:
            "Tailnet-only HTTPS via Tailscale Serve."
        case .funnel:
            "Public HTTPS via Tailscale Funnel (requires auth)."
        }
    }
}

private enum GatewayAuthMode: String, CaseIterable, Identifiable {
    case system
    case password

    var id: String { self.rawValue }

    var label: String {
        switch self {
        case .system: "System password"
        case .password: "Shared password"
        }
    }
}

struct TailscaleIntegrationSection: View {
    let connectionMode: AppState.ConnectionMode
    let isPaused: Bool

    @Environment(TailscaleService.self) private var tailscaleService

    @State private var hasLoaded = false
    @State private var tailscaleMode: GatewayTailscaleMode = .off
    @State private var requireCredentialsForServe = false
    @State private var authMode: GatewayAuthMode = .system
    @State private var username: String = ""
    @State private var password: String = ""
    @State private var statusMessage: String?
    @State private var validationMessage: String?
    @State private var statusTimer: Timer?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Tailscale (dashboard access)")
                .font(.callout.weight(.semibold))

            self.statusRow

            if !self.tailscaleService.isInstalled {
                self.installButtons
            } else {
                self.modePicker
                if self.tailscaleMode != .off {
                    self.accessURLRow
                }
                if self.tailscaleMode == .serve {
                    self.serveAuthSection
                }
                if self.tailscaleMode == .funnel {
                    self.funnelAuthSection
                }
            }

            if self.connectionMode != .local {
                Text("Local mode required. Update settings on the gateway host.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let validationMessage {
                Text(validationMessage)
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if let statusMessage {
                Text(statusMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
        .disabled(self.connectionMode != .local)
        .task {
            guard !self.hasLoaded else { return }
            self.hasLoaded = true
            self.loadConfig()
            await self.tailscaleService.checkTailscaleStatus()
            self.startStatusTimer()
        }
        .onDisappear {
            self.stopStatusTimer()
        }
        .onChange(of: self.tailscaleMode) { _, _ in
            self.applySettings()
        }
        .onChange(of: self.requireCredentialsForServe) { _, _ in
            self.applySettings()
        }
        .onChange(of: self.authMode) { _, _ in
            self.applySettings()
        }
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(self.statusColor)
                .frame(width: 10, height: 10)
            Text(self.statusText)
                .font(.callout)
            Spacer()
            Button("Refresh") {
                Task { await self.tailscaleService.checkTailscaleStatus() }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private var statusColor: Color {
        if !self.tailscaleService.isInstalled { return .yellow }
        if self.tailscaleService.isRunning { return .green }
        return .orange
    }

    private var statusText: String {
        if !self.tailscaleService.isInstalled { return "Tailscale is not installed" }
        if self.tailscaleService.isRunning { return "Tailscale is installed and running" }
        return "Tailscale is installed but not running"
    }

    private var installButtons: some View {
        HStack(spacing: 12) {
            Button("App Store") { self.tailscaleService.openAppStore() }
                .buttonStyle(.link)
            Button("Direct Download") { self.tailscaleService.openDownloadPage() }
                .buttonStyle(.link)
            Button("Setup Guide") { self.tailscaleService.openSetupGuide() }
                .buttonStyle(.link)
        }
        .controlSize(.small)
    }

    private var modePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Exposure mode")
                .font(.callout.weight(.semibold))
            Picker("Exposure", selection: self.$tailscaleMode) {
                ForEach(GatewayTailscaleMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            Text(self.tailscaleMode.description)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var accessURLRow: some View {
        if let host = self.tailscaleService.tailscaleHostname {
            let url = "https://\(host)/ui/"
            HStack(spacing: 8) {
                Text("Dashboard URL:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let link = URL(string: url) {
                    Link(url, destination: link)
                        .font(.system(.caption, design: .monospaced))
                } else {
                    Text(url)
                        .font(.system(.caption, design: .monospaced))
                }
            }
        } else if !self.tailscaleService.isRunning {
            Text("Start Tailscale to get your tailnet hostname.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }

        if self.tailscaleService.isInstalled, !self.tailscaleService.isRunning {
            Button("Start Tailscale") { self.tailscaleService.openTailscaleApp() }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
    }

    private var serveAuthSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle("Require credentials", isOn: self.$requireCredentialsForServe)
                .toggleStyle(.checkbox)
            if self.requireCredentialsForServe {
                self.authModePicker
                self.authFields
            } else {
                Text("Serve uses Tailscale identity headers; no password required.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var funnelAuthSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Funnel requires authentication.")
                .font(.caption)
                .foregroundStyle(.secondary)
            self.authModePicker
            self.authFields
        }
    }

    private var authModePicker: some View {
        Picker("Auth", selection: self.$authMode) {
            ForEach(GatewayAuthMode.allCases) { mode in
                Text(mode.label).tag(mode)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private var authFields: some View {
        if self.authMode == .system {
            TextField("Username (optional)", text: self.$username)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
                .onSubmit { self.applySettings() }
        } else {
            SecureField("Password", text: self.$password)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
                .onSubmit { self.applySettings() }
            Text("Stored in ~/.clawdis/clawdis.json. Prefer CLAWDIS_GATEWAY_PASSWORD for production.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Update password") { self.applySettings() }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }

    private func loadConfig() {
        let gateway = ClawdisConfigFile.loadGatewayDict()
        let tailscale = gateway["tailscale"] as? [String: Any] ?? [:]
        let modeRaw = (tailscale["mode"] as? String) ?? "off"
        self.tailscaleMode = GatewayTailscaleMode(rawValue: modeRaw) ?? .off

        let auth = gateway["auth"] as? [String: Any] ?? [:]
        let authModeRaw = auth["mode"] as? String
        let allowTailscale = auth["allowTailscale"] as? Bool

        if let authModeRaw, authModeRaw == "password" {
            self.authMode = .password
        } else {
            self.authMode = .system
        }

        self.username = auth["username"] as? String ?? ""
        self.password = auth["password"] as? String ?? ""

        if self.tailscaleMode == .serve {
            let usesExplicitAuth = authModeRaw == "password" || authModeRaw == "system"
            if let allowTailscale, allowTailscale == false {
                self.requireCredentialsForServe = true
            } else {
                self.requireCredentialsForServe = usesExplicitAuth
            }
        } else {
            self.requireCredentialsForServe = false
        }
    }

    private func applySettings() {
        guard self.hasLoaded else { return }
        self.validationMessage = nil
        self.statusMessage = nil

        let trimmedPassword = self.password.trimmingCharacters(in: .whitespacesAndNewlines)
        let requiresPassword = self.tailscaleMode == .funnel
            || (self.tailscaleMode == .serve && self.requireCredentialsForServe)
        if requiresPassword, self.authMode == .password, trimmedPassword.isEmpty {
            self.validationMessage = "Password required for this mode."
            return
        }

        ClawdisConfigFile.updateGatewayDict { gateway in
            var tailscale = gateway["tailscale"] as? [String: Any] ?? [:]
            tailscale["mode"] = self.tailscaleMode.rawValue
            gateway["tailscale"] = tailscale

            if self.tailscaleMode != .off {
                gateway["bind"] = "loopback"
            }

            guard self.tailscaleMode != .off else { return }
            var auth = gateway["auth"] as? [String: Any] ?? [:]

            if self.tailscaleMode == .serve, !self.requireCredentialsForServe {
                auth["allowTailscale"] = true
                auth.removeValue(forKey: "mode")
                auth.removeValue(forKey: "password")
                auth.removeValue(forKey: "username")
            } else {
                auth["allowTailscale"] = false
                auth["mode"] = self.authMode.rawValue
                if self.authMode == .password {
                    auth["password"] = trimmedPassword
                    auth.removeValue(forKey: "username")
                } else {
                    let trimmedUsername = self.username.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmedUsername.isEmpty {
                        auth.removeValue(forKey: "username")
                    } else {
                        auth["username"] = trimmedUsername
                    }
                    auth.removeValue(forKey: "password")
                }
            }

            if auth.isEmpty {
                gateway.removeValue(forKey: "auth")
            } else {
                gateway["auth"] = auth
            }
        }

        if self.connectionMode == .local, !self.isPaused {
            self.statusMessage = "Saved to ~/.clawdis/clawdis.json. Restarting gateway…"
        } else {
            self.statusMessage = "Saved to ~/.clawdis/clawdis.json. Restart the gateway to apply."
        }
        self.restartGatewayIfNeeded()
    }

    private func restartGatewayIfNeeded() {
        guard self.connectionMode == .local, !self.isPaused else { return }
        Task { await GatewayLaunchAgentManager.kickstart() }
    }

    private func startStatusTimer() {
        self.stopStatusTimer()
        self.statusTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { await self.tailscaleService.checkTailscaleStatus() }
        }
    }

    private func stopStatusTimer() {
        self.statusTimer?.invalidate()
        self.statusTimer = nil
    }
}
