import Foundation

extension GatewayProcessManager {
    func restartRelocatedBundledGatewayIfNeeded(bundle: Bundle = .main) async {
        guard self.desiredActive, !self.isTerminating, !Task.isCancelled,
              !self.hostingChangeInProgress, !AppStateStore.shared.isPaused,
              let executable = self.childSupervisor.configuration?.executable
        else { return }
        let launchedBundle = executable.deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        guard launchedBundle.pathExtension == "app",
              executable == launchedBundle.appendingPathComponent("Contents/Resources/runtime/openclaw")
        else { return }
        let currentBundle = BundledRuntime.currentBundleURL(bundle)
        guard launchedBundle.standardizedFileURL != currentBundle.standardizedFileURL,
              self.gatewayHosting == .app, self.installation == .managed
        else { return }

        // The kernel follows a moved executable, but lazy imports retain the old absolute paths.
        // Keep replacement watching at the install location; only the child runtime needs restarting.
        self.bundleRelocationStatus = "App moved. Restarting the Gateway…"
        self.appendLog("[gateway] app moved; restarting the bundled Gateway\n")
        let runtime: BundledRuntime
        self.hostingChangeInProgress = true
        do {
            defer { self.hostingChangeInProgress = false }
            self.stop(preservingActivationIntent: true)
            let generation = self.gatewayStartGeneration
            self.runtimePreparationTask?.cancel()
            await BundledRuntime.cancelSeeding()
            await self.runtimePreparationTask?.value
            self.runtimePreparationTask = nil
            self.runtimePreparationAttempted = false
            await self.waitForStartupAttempt()
            guard self.isCurrentGatewayStart(generation), !Task.isCancelled,
                  !AppStateStore.shared.isPaused, self.gatewayHosting == .app
            else {
                self.bundleRelocationStatus = nil
                return
            }
            runtime = try BundledRuntime.forAppHosting(bundle: bundle)
        } catch {
            self.fail(error.localizedDescription)
            self.bundleRelocationStatus = "App moved. \(self.status.label)"
            self.appendLog("[gateway] \(error.localizedDescription)\n")
            return
        }
        self.startIfNeeded(appRuntime: runtime)
        await self.waitForStartupAttempt()
        if case .running = self.status {
            self.bundleRelocationStatus = "App moved. Gateway restarted."
        } else {
            self.bundleRelocationStatus = "App moved. \(self.status.label)"
        }
    }
}
