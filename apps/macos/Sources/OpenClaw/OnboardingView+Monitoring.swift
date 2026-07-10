import Foundation
import OpenClawIPC

extension OnboardingView {
    @MainActor
    func refreshPerms() async {
        await permissionMonitor.refreshNow()
    }

    @MainActor
    func request(_ cap: Capability) async {
        guard !isRequesting else { return }
        isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    func updatePermissionMonitoring(for pageIndex: Int) {
        PermissionMonitoringSupport.setMonitoring(
            pageIndex == permissionsPageIndex,
            monitoring: &monitoringPermissions)
    }

    func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !monitoringDiscovery {
            monitoringDiscovery = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard self.monitoringDiscovery else { return }
                self.gatewayDiscovery.start()
                await self.refreshLocalGatewayProbe()
            }
        } else if !shouldMonitor, monitoringDiscovery {
            monitoringDiscovery = false
            gatewayDiscovery.stop()
        }
    }

    func updateMonitoring(for pageIndex: Int) {
        self.updatePermissionMonitoring(for: pageIndex)
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.maybeInstallCLI(for: pageIndex)
        self.maybeStartAISetup(for: pageIndex)
        // AI setup creates the workspace (BOOTSTRAP.md); re-check so the
        // Meet-your-agent page joins the flow once setup ran.
        self.refreshBootstrapStatus()
        maybeKickoffOnboardingChat(for: pageIndex)
    }

    func maybeInstallCLI(for pageIndex: Int) {
        guard Self.shouldAutoInstallCLI(
            onCLIPage: pageIndex == cliPageIndex,
            isLocal: state.connectionMode == .local,
            visible: onboardingVisible,
            statusKnown: cliStatusKnown,
            installed: cliInstalled,
            installing: installingCLI)
        else { return }
        self.startCLIInstall()
    }

    static func shouldAutoInstallCLI(
        onCLIPage: Bool,
        isLocal: Bool,
        visible: Bool,
        statusKnown: Bool,
        installed: Bool,
        installing: Bool) -> Bool
    {
        onCLIPage && isLocal && visible && statusKnown && !installed && !installing
    }

    func startCLIInstall() {
        guard self.onboardingVisible, !installingCLI else { return }
        installingCLI = true
        OnboardingController.shared.setWindowCloseEnabled(false)
        // Cmd-W bypasses the disabled close button; the delegate asks first.
        OnboardingController.shared.busyReason = "OpenClaw is installing the Gateway service."
        Task { @MainActor in await self.runCLIInstall() }
    }

    func stopPermissionMonitoring() {
        PermissionMonitoringSupport.stopMonitoring(&monitoringPermissions)
    }

    func stopDiscovery() {
        guard monitoringDiscovery else { return }
        monitoringDiscovery = false
        gatewayDiscovery.stop()
    }

    func runCLIInstall() async {
        self.cliInstallPhase = .installing
        defer {
            self.installingCLI = false
            self.cliInstallPhase = .idle
            OnboardingController.shared.setWindowCloseEnabled(true)
            OnboardingController.shared.busyReason = nil
        }
        let installed = await CLIInstaller.install { message in
            self.cliStatus = message
        }
        guard installed else { return }
        cliInstallLocation = CLIInstaller.managedExecutableLocation()
        cliStatus = "Starting OpenClaw Gateway…"
        // The step checklist shows one spinner at a time: install first,
        // then the service start.
        self.cliInstallPhase = .startingService
        switch await CLIInstaller.activateLocalGateway() {
        case .ready:
            cliStatus = "OpenClaw Gateway is ready."
        case .deferred:
            cliStatus = "OpenClaw is installed. The Gateway will start when This Mac is active and resumed."
        case .failed:
            cliStatus = "OpenClaw was installed, but the Gateway did not start. Retry setup."
            return
        }
        cliInstalled = true
    }

    func refreshCLIStatus() async {
        let status = await CLIInstaller.status()
        // A startup probe may still be running when the user reaches the install page.
        // Never let that stale result replace live installation progress.
        guard self.onboardingVisible, !Task.isCancelled, !installingCLI else { return }
        cliInstallLocation = status.location
        cliInstalled = status.isReady
        cliStatusKnown = true
        cliStatus = status.message
        self.maybeInstallCLI(for: self.activePageIndex)
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
}
