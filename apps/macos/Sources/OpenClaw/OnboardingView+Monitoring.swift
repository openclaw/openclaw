import Foundation
import OpenClawIPC
import OpenClawKit

extension OnboardingView {
    @MainActor
    func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    @MainActor
    func request(_ cap: Capability) async {
        guard !self.isRequesting else { return }
        self.isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    func updatePermissionMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.permissionsPageIndex
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == self.connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !self.monitoringDiscovery {
            self.monitoringDiscovery = true
            // If the CLI is installed and gateway was started (or user kept the toggle on),
            // default to "This Mac".
            if self.cliInstalled, self.startGatewayAfterInstall, self.state.connectionMode != .local {
                self.selectLocalGateway()
            }
            // If config says local but CLI is gone, reset to unconfigured.
            if !self.cliInstalled, self.state.connectionMode == .local {
                self.state.connectionMode = .unconfigured
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard self.monitoringDiscovery else { return }
                self.gatewayDiscovery.start()
                await self.refreshLocalGatewayProbe()
            }
        } else if !shouldMonitor, self.monitoringDiscovery {
            self.monitoringDiscovery = false
            self.gatewayDiscovery.stop()
        }
    }

    func updateMonitoring(for pageIndex: Int) {
        self.updatePermissionMonitoring(for: pageIndex)
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.updateAuthMonitoring(for: pageIndex)
        self.maybeKickoffOnboardingChat(for: pageIndex)
    }

    func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }

    func stopDiscovery() {
        guard self.monitoringDiscovery else { return }
        self.monitoringDiscovery = false
        self.gatewayDiscovery.stop()
    }

    func updateAuthMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.anthropicAuthPageIndex && self.state.connectionMode == .local
        if shouldMonitor, !self.monitoringAuth {
            self.monitoringAuth = true
            self.startAuthMonitoring()
        } else if !shouldMonitor, self.monitoringAuth {
            self.stopAuthMonitoring()
        }
    }

    func startAuthMonitoring() {
        self.refreshAnthropicOAuthStatus()
        self.authMonitorTask?.cancel()
        self.authMonitorTask = Task {
            while !Task.isCancelled {
                await MainActor.run { self.refreshAnthropicOAuthStatus() }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func stopAuthMonitoring() {
        self.monitoringAuth = false
        self.authMonitorTask?.cancel()
        self.authMonitorTask = nil
    }

    func installCLI() async {
        guard !self.installingCLI else { return }
        self.installingCLI = true
        self.gatewayStarted = false
        self.gatewayInstallStatus = nil
        await CLIInstaller.install { message in
            self.cliStatus = message
        }
        self.installingCLI = false
        self.refreshCLIStatus()
        if self.cliInstalled, self.startGatewayAfterInstall {
            await self.installAndStartGateway()
        }
    }

    func installAndStartGateway() async {
        guard !self.installingGateway else { return }
        self.installingGateway = true
        self.gatewayStarted = false
        defer { self.installingGateway = false }

        // Pre-select "This Mac" so the Gateway page shows it selected and
        // AppState.syncGatewayConfigIfNeeded() writes gateway.mode=local
        // to the config file (the gateway refuses to start without it).
        if self.state.connectionMode != .local {
            self.selectLocalGateway()
        }

        // syncGatewayConfigIfNeeded() defers its write inside a Task, so after a
        // full reset the config file may not exist yet when the gateway starts.
        // Write gateway.mode=local directly so the gateway finds it immediately.
        OpenClawConfigFile.updateGatewayDict { gateway in
            gateway["mode"] = "local"
        }

        let mgr = GatewayProcessManager.shared
        let port = GatewayEnvironment.gatewayPort()

        // If the gateway is already running (e.g. reinstall, or after a
        // --reset-onboarding), stop it first so the restarted process picks up
        // the freshly installed CLI binary.
        var alreadyRunning = mgr.status.isReady
        if !alreadyRunning {
            alreadyRunning = await PortGuardian.shared.isListening(port: port)
        }
        if alreadyRunning {
            self.gatewayInstallStatus = "Restarting gateway…"
            mgr.stop()
            // Give launchd a moment to tear down the old process.
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }

        // Trigger gateway start — this installs the launchd plist and attempts
        // a 15s health check internally. The plist has KeepAlive=true so launchd
        // will keep retrying even if the first cold start is slow.
        self.gatewayInstallStatus = "Starting gateway…"
        mgr.setActive(true)

        // Wait for the process manager to resolve. It does its own port checks
        // internally (attachExistingGatewayIfAvailable + enableLaunchdGateway).
        // We only read mgr.status here (no async subprocess calls) so the
        // counter ticks smoothly without main-actor contention.
        let startTime = Date()
        let deadline = startTime.addingTimeInterval(60)
        while Date() < deadline {
            // Update elapsed counter on every iteration so the UI feels alive.
            let secs = Int(Date().timeIntervalSince(startTime))
            self.gatewayInstallStatus = "Starting gateway… (\(secs)s)"

            // Check if the process manager already marked it ready.
            if mgr.status.isReady {
                self.gatewayStarted = true
                self.gatewayInstallStatus = "Gateway running"
                return
            }

            // The process manager may report .failed even when a listener is
            // present (e.g. health check fails due to pending device pairing).
            // For onboarding, a listener on the port is good enough — auth
            // will resolve via the control channel after pairing.
            if case .failed = mgr.status,
               mgr.existingGatewayDetails != nil
            {
                self.gatewayStarted = true
                self.gatewayInstallStatus = "Gateway running"
                mgr.clearLastFailure()
                return
            }

            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }

        // Final fallback: the process manager timed out but the port may have
        // come up after its internal deadline. One last TCP check.
        if await PortGuardian.shared.isListening(port: port) {
            self.gatewayStarted = true
            self.gatewayInstallStatus = "Gateway running"
            mgr.clearLastFailure()
            return
        }

        let reason = mgr.lastFailureReason
        self.gatewayInstallStatus = "Gateway failed to start: \(reason ?? "timed out")"
    }

    func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    func refreshGatewayStatus() {
        switch GatewayProcessManager.shared.status {
        case .running, .attachedExisting:
            self.gatewayStarted = true
            self.gatewayInstallStatus = "Gateway running"
        default:
            break
        }
    }

    /// Performs a full reset of the OpenClaw installation:
    /// stops the gateway, removes launchd service, wipes ~/.openclaw,
    /// clears device auth tokens, and resets UI state.
    func resetInstallation() async {
        guard !self.resettingInstallation else { return }
        self.resettingInstallation = true
        defer { self.resettingInstallation = false }

        // 1. Stop the gateway process manager.
        let mgr = GatewayProcessManager.shared
        mgr.stop()

        // 2. Bootout the gateway launchd service and remove its plist.
        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        _ = await GatewayLaunchAgentManager.set(enabled: false, bundlePath: bundlePath, port: port)

        // Also bootout directly in case the CLI uninstall didn't cover it.
        await Task.detached(priority: .utility) {
            let process = Process()
            process.launchPath = "/bin/launchctl"
            process.arguments = ["bootout", "gui/\(getuid())/\(gatewayLaunchdLabel)"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
            process.waitUntilExit()
        }.value

        // Remove the gateway plist file directly.
        let plistPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(gatewayLaunchdLabel).plist")
        try? FileManager.default.removeItem(at: plistPath)

        // 3. Remove ~/.openclaw (CLI, config, sessions, credentials, etc.)
        let openclawDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw")
        try? FileManager.default.removeItem(at: openclawDir)

        // 4. Clear device auth tokens (persisted outside ~/.openclaw).
        DeviceAuthStore.clearAllTokens()

        // 5. Reset UI state so the Install page is ready for a fresh install.
        self.cliInstalled = false
        self.cliInstallLocation = nil
        self.cliStatus = nil
        self.gatewayStarted = false
        self.gatewayInstallStatus = nil
        self.installingGateway = false
        self.installingCLI = false
        mgr.clearLog()
    }

    func refreshLocalGatewayProbe() async {
        let port = GatewayEnvironment.gatewayPort()
        let desc = await PortGuardian.shared.describe(port: port)
        await MainActor.run {
            guard let desc else {
                self.localGatewayProbe = nil
                return
            }
            let command = desc.command.trimmingCharacters(in: .whitespacesAndNewlines)
            let expectedTokens = ["node", "openclaw", "tsx", "pnpm", "bun"]
            let lower = command.lowercased()
            let expected = expectedTokens.contains { lower.contains($0) }
            self.localGatewayProbe = LocalGatewayProbe(
                port: port,
                pid: desc.pid,
                command: command,
                expected: expected)
        }
    }

    func refreshAnthropicOAuthStatus() {
        _ = OpenClawOAuthStore.importLegacyAnthropicOAuthIfNeeded()
        let previous = self.anthropicAuthDetectedStatus
        let status = OpenClawOAuthStore.anthropicOAuthStatus()
        self.anthropicAuthDetectedStatus = status
        self.anthropicAuthConnected = status.isConnected

        if previous != status {
            self.anthropicAuthVerified = false
            self.anthropicAuthVerificationAttempted = false
            self.anthropicAuthVerificationFailed = false
            self.anthropicAuthVerifiedAt = nil
        }
    }

    @MainActor
    func verifyAnthropicOAuthIfNeeded(force: Bool = false) async {
        guard self.state.connectionMode == .local else { return }
        guard self.anthropicAuthDetectedStatus.isConnected else { return }
        if self.anthropicAuthVerified, !force { return }
        if self.anthropicAuthVerifying { return }
        if self.anthropicAuthVerificationAttempted, !force { return }

        self.anthropicAuthVerificationAttempted = true
        self.anthropicAuthVerifying = true
        self.anthropicAuthVerificationFailed = false
        defer { self.anthropicAuthVerifying = false }

        guard let refresh = OpenClawOAuthStore.loadAnthropicOAuthRefreshToken(), !refresh.isEmpty else {
            self.anthropicAuthStatus = "OAuth verification failed: missing refresh token."
            self.anthropicAuthVerificationFailed = true
            return
        }

        do {
            let updated = try await AnthropicOAuth.refresh(refreshToken: refresh)
            try OpenClawOAuthStore.saveAnthropicOAuth(updated)
            self.refreshAnthropicOAuthStatus()
            self.anthropicAuthVerified = true
            self.anthropicAuthVerifiedAt = Date()
            self.anthropicAuthVerificationFailed = false
            self.anthropicAuthStatus = "OAuth detected and verified."
        } catch {
            self.anthropicAuthVerified = false
            self.anthropicAuthVerifiedAt = nil
            self.anthropicAuthVerificationFailed = true
            self.anthropicAuthStatus = "OAuth verification failed: \(error.localizedDescription)"
        }
    }
}
