import Foundation
import OpenClawIPC

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
        PermissionMonitoringSupport.setMonitoring(
            pageIndex == self.permissionsPageIndex,
            monitoring: &self.monitoringPermissions)
    }

    func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == self.connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !self.monitoringDiscovery {
            self.monitoringDiscovery = true
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
        self.maybeKickoffOnboardingChat(for: pageIndex)
        if pageIndex == self.cliPageIndex {
            Task { @MainActor in
                await self.refreshCLIInstallerReadiness()
            }
        }
    }

    func stopPermissionMonitoring() {
        PermissionMonitoringSupport.stopMonitoring(&self.monitoringPermissions)
    }

    func stopDiscovery() {
        guard self.monitoringDiscovery else { return }
        self.monitoringDiscovery = false
        self.gatewayDiscovery.stop()
    }

    func installCLI() async {
        guard !self.installingCLI else { return }
        await self.refreshCLIInstallerReadiness()

        if self.cliNeedsCommandLineTools {
            await self.requestCommandLineToolsInstall()
            return
        }

        self.installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            self.cliStatus = message
        }
        self.refreshCLIStatus()
        await self.refreshCLIInstallerReadiness()
    }

    func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    @MainActor
    func refreshCLIInstallerReadiness() async {
        self.refreshCLIStatus()

        if self.cliInstalled {
            self.cliNeedsCommandLineTools = false
            self.cliPreflightStatus = nil
            return
        }

        let preflight = await CLIInstaller.preflight()
        self.cliNeedsCommandLineTools = preflight.needsCommandLineTools
        self.cliPreflightStatus = preflight.message
    }

    @MainActor
    func requestCommandLineToolsInstall() async {
        await CLIInstaller.requestCommandLineToolsInstall { message in
            self.cliPreflightStatus = message
        }
        await self.refreshCLIInstallerReadiness()
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
