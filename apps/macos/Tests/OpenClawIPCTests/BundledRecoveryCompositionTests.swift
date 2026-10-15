import AppKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// This process-hosted composition runs only in the disposable, staged .app lane.
/// The ordinary SwiftPM suite retains its cheaper owner-level controls.
@Suite(.testWaitLimit)
@MainActor
struct BundledRecoveryCompositionTests {
    private nonisolated static var isAppHost: Bool {
        Bundle.main.bundleIdentifier == "ai.openclaw.mac.recovery-fixture" &&
            BundledRuntime.isBundledApp && AppProfile.current.isActive
    }

    private let pluginID = "scott-recovery-composition"

    @Test(.enabled(if: Self.isAppHost))
    func `ordinary retry`() async throws {
        try await AppKitTestSupport.startApplication()
        let state = AppProfile.current.stateDirectoryURL()
        try #require(state.resolvingSymlinksInPath() == OpenClawPaths.stateDirURL.resolvingSymlinksInPath())
        let runtime = try await BundledRuntime.seed()
        // ShellExecutor replaces the child environment; retain the app owner's profile and state.
        let environment = try GatewayProcessManager.shared.appHostedEnvironment(runtime: runtime)
        let version = try #require(GatewayEnvironment.appVersionString())
        let config: [String: Any] = [
            "gateway": [
                "mode": "local", "port": GatewayEnvironment.gatewayPort(),
                "auth": ["mode": "token", "token": "synthetic-composition-token"],
                "controlUi": ["enabled": false],
            ],
            "plugins": ["allow": [self.pluginID], "slots": ["memory": "none"]],
        ]
        try JSONSerialization.data(withJSONObject: config).write(to: OpenClawPaths.configURL)
        // The schema probe needs the creation owner's registration and deletion history.
        let created = await ShellExecutor.runDetailed(
            command: runtime.cliCommand + [
                "agents", "add", "recovery", "--workspace", state.appendingPathComponent("workspace").path,
                "--agent-dir", state.appendingPathComponent("agents/recovery/agent").path,
                "--non-interactive", "--json",
            ],
            cwd: runtime.packageRoot.path,
            env: environment,
            timeout: CLIInstaller.managedUpdateTimeout)
        try #require(created.success, Comment(rawValue: created.stderr))
        let selected = await ShellExecutor.runDetailed(
            command: runtime.cliCommand + ["config", "set", "agents.defaults.systemAgent.agentId", "recovery"],
            cwd: runtime.packageRoot.path,
            env: environment,
            timeout: CLIInstaller.managedUpdateTimeout)
        try #require(selected.success, Comment(rawValue: selected.stderr))
        try await self.installPlugin(runtime: runtime, state: state, environment: environment)
        AppDefaults.standard.set(GatewayHosting.service.rawValue, forKey: GatewayHosting.defaultsKey)
        AppStateStore.shared.connectionMode = .local
        AppStateStore.shared.onboardingSeen = true
        AppStateStore.shared.isPaused = false
        let manager = GatewayProcessManager.shared
        do {
            manager.setActive(true, source: .request)
            await manager.waitForStartupAttempt()
            let serviceReady = switch manager.status {
            case .running, .attachedExisting: true
            default: false
            }
            try #require(
                serviceReady && manager.lastFailureReason == nil,
                Comment(rawValue: "Initial service startup: tests=\(ProcessInfo.processInfo.isRunningTests) " +
                    "activation=\(NSApp.activationPolicy()) status=\(manager.status) " +
                    "failure=\(manager.lastFailureReason ?? "none") log=\(manager.log.suffix(2048))"))
            #expect(try await GatewayConnection.shared.healthOK())
            let command = try #require(GatewayLaunchAgentManager.launchdProgramArguments())
            #expect(command.contains("--no-install"))
            let inspected = try #require(GatewayLaunchAgentManager.installedServiceCLI())
            #expect(inspected.prefix.first == runtime.bun.path)

            // Same-version shell and app packages must not be interchangeable host-link owners.
            let wrongRoot = state.appendingPathComponent("other-install")
            try FileManager.default.createDirectory(at: wrongRoot, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: [
                "name": "openclaw", "version": version, "type": "module",
                "exports": ["./plugin-sdk/plugin-entry": "./missing-sdk.js"],
            ]).write(to: wrongRoot.appendingPathComponent("package.json"))
            let peer = state.appendingPathComponent("extensions/\(self.pluginID)/node_modules/openclaw")
            try FileManager.default.createDirectory(
                at: peer.deletingLastPathComponent(), withIntermediateDirectories: true)
            do {
                try FileManager.default.removeItem(at: peer)
            } catch let error as CocoaError where error.code == .fileNoSuchFile {
                // The Gateway can resolve SDK aliases even when this physical peer link is absent.
            }
            try FileManager.default.createSymbolicLink(at: peer, withDestinationURL: wrongRoot)
            try #require(try FileManager.default.destinationOfSymbolicLink(atPath: peer.path) == wrongRoot.path)
            let probe = state.appendingPathComponent("extensions/\(self.pluginID)/peer-health.mjs")
            let before = await ShellExecutor.runDetailed(
                command: [runtime.bun.path, probe.path], cwd: nil, env: environment, timeout: 30)
            try #require(!before.success)

            AppStateStore.shared.isPaused = true
            manager.stop()
            await manager.waitForStartupAttempt()
            try #require(manager.status == .stopped && manager.lastFailureReason == nil)
            try #require(GatewayLaunchAgentManager.launchdProgramArguments() == [])
            let stoppedService = try #require(
                try await GatewayLaunchAgentManager.loadedGatewayState(port: GatewayEnvironment.gatewayPort()))
            try #require(stoppedService.runningPID == nil)
            let agent = state.appendingPathComponent("agents/recovery/agent/openclaw-agent.sqlite")
            try #require(FileManager.default.fileExists(atPath: agent.path))
            let artifacts = [
                agent,
                URL(fileURLWithPath: agent.path + "-wal"),
                URL(fileURLWithPath: agent.path + "-shm"),
            ]
            let retained = artifacts.filter { FileManager.default.fileExists(atPath: $0.path) }
            for artifact in retained {
                try FileManager.default.moveItem(
                    at: artifact,
                    to: artifact.appendingPathExtension("composition-original"))
            }
            for artifact in retained {
                try FileManager.default.copyItem(
                    at: artifact.appendingPathExtension("composition-original"),
                    to: artifact)
            }
            // Newer schemas are a required refusal, unlike isolatable secondary-agent diagnostics.
            let future = await ShellExecutor.runDetailed(
                command: ["/usr/bin/sqlite3", agent.path, "PRAGMA user_version=2147483646;"],
                cwd: nil,
                env: [:],
                timeout: 30)
            #expect(future.success)
            let futureBytes = try Data(contentsOf: agent)

            let receipt = PostAppUpdateReceipt(
                fromVersion: "2026.10.1",
                toVersion: version,
                recordedAt: Date(),
                notificationInFlight: true,
                runtimeBuildID: Bundle.main.infoDictionary?["OpenClawRuntimeBuildID"] as? String)
            let checkpoint = PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: receipt, owner: .gateway)
            #expect(!checkpoint.setupRecovery && checkpoint.coreUpdatePending)
            #expect(PostUpdateController.shared.startIfNeeded())
            let window = try await self.updateWindow()
            _ = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "paused recovery", matching: { elements in
                    elements.first {
                        let value: Any? = $0.accessibilityValue?()
                        return $0.accessibilityRole?() == .staticText &&
                            (value as? String)?.contains("Resume OpenClaw") == true
                    }
                })
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: version)?.coreUpdatePending == true)

            AppStateStore.shared.isPaused = false
            PostUpdateController.shared.retry()
            let diagnostic = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "newer-schema Doctor outcome", matching: { elements in
                    elements.first {
                        let value: Any? = $0.accessibilityValue?()
                        return $0.accessibilityRole?() == .staticText &&
                            (value as? String)?.contains("2147483646") == true
                    } ?? elements.first {
                        let value: Any? = $0.accessibilityValue?()
                        let text = value as? String
                        return $0.accessibilityRole?() == .staticText &&
                            text?.contains("The bundled Gateway update could not finish.") == true
                    }
                })
            let diagnosticValue: Any? = diagnostic.accessibilityValue?()
            try #require(
                (diagnosticValue as? String)?.contains("2147483646") == true,
                Comment(rawValue: "Unexpected recovery refusal: log=\(manager.log)"))
            _ = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "required newer-schema refusal", matching: { elements in
                    elements.first { $0.accessibilityRole?() == .button && $0.accessibilityLabel?() == "Retry" }
                })
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: version)?.coreUpdatePending == true)
            #expect(try Data(contentsOf: agent) == futureBytes)
            manager.stop()
            await manager.waitForStartupAttempt()
            try #require(manager.status == .stopped && manager.lastFailureReason == nil)
            try #require(GatewayLaunchAgentManager.launchdProgramArguments() == [])
            let stoppedAfterRefusal = try #require(
                try await GatewayLaunchAgentManager.loadedGatewayState(port: GatewayEnvironment.gatewayPort()))
            try #require(stoppedAfterRefusal.runningPID == nil)
            for artifact in artifacts where FileManager.default.fileExists(atPath: artifact.path) {
                try FileManager.default.removeItem(at: artifact)
            }
            for artifact in retained {
                try FileManager.default.moveItem(
                    at: artifact.appendingPathExtension("composition-original"),
                    to: artifact)
            }

            PostUpdateController.shared.retry()
            let receiptChanged = AsyncTestSignal()
            let observation = NotificationCenter.default.addObserver(
                forName: UserDefaults.didChangeNotification,
                object: nil,
                queue: .main,
                using: { _ in receiptChanged.notify() })
            defer { NotificationCenter.default.removeObserver(observation) }
            try await receiptChanged.wait("ordinary recovery receipt completion") {
                AppDefaults.standard.data(forKey: postAppUpdateReceiptKey) == nil
            }
            #expect(try await GatewayConnection.shared.healthOK())
            let after = await ShellExecutor.runDetailed(
                command: [runtime.bun.path, probe.path], cwd: nil, env: environment, timeout: 30)
            #expect(after.success)
            #expect(after.stdout.contains(runtime.packageRoot.path))
            let health = try await GatewayConnection.shared.request(method: "health", params: nil)
            let healthObject = try #require(try JSONSerialization.jsonObject(with: health) as? [String: Any])
            #expect(healthObject["ok"] as? Bool == true)
            let plugins = try #require(healthObject["plugins"] as? [String: Any])
            #expect((plugins["errors"] as? [Any])?.isEmpty == true)
            #expect((plugins["loaded"] as? [String])?.contains(self.pluginID) == true)
            #expect(try FileManager.default.destinationOfSymbolicLink(atPath: peer.path) == runtime.packageRoot.path)
            #expect(AppDefaults.standard.synchronize())
            PostUpdateController.shared.close()
            await GatewayConnection.shared.shutdown()
            // The launcher retains this exact named service until the fresh relaunch host joins it.
        } catch {
            // Cancellation otherwise hides the accessibility snapshot carried by the wait failure.
            print("Bundled recovery composition failed: \(error.localizedDescription)")
            print("Bundled recovery lifecycle diagnostics: \(manager.log)")
            // The still-live app owner joins its service stop before a failed fixture host exits.
            manager.stop()
            await manager.waitForStartupAttempt()
            #expect(manager.status == .stopped && manager.lastFailureReason == nil)
            #expect(GatewayLaunchAgentManager.launchdProgramArguments() == [])
            do {
                let stopped = try await GatewayLaunchAgentManager.loadedGatewayState(
                    port: GatewayEnvironment.gatewayPort())
                #expect(stopped != nil)
                #expect(stopped?.runningPID == nil)
            } catch {
                Issue.record("The fixture's Gateway stop could not be inspected.")
            }
            throw error
        }
    }

    @Test(.enabled(if: Self.isAppHost))
    func relaunch() async throws {
        try await AppKitTestSupport.startApplication()
        #expect(AppDefaults.standard.data(forKey: postAppUpdateReceiptKey) == nil)
        let manager = GatewayProcessManager.shared
        let state = AppStateStore.shared
        state.connectionMode = .local
        await ConnectionModeCoordinator.shared.apply(mode: state.connectionMode, paused: state.isPaused)
        #expect(PostUpdateController.shared.startIfNeeded())
        await manager.waitForStartupAttempt()
        let serviceReady = switch manager.status {
        case .running, .attachedExisting: true
        default: false
        }
        try #require(
            serviceReady && manager.lastFailureReason == nil,
            Comment(rawValue: "Relaunch service startup: tests=\(ProcessInfo.processInfo.isRunningTests) " +
                "activation=\(NSApp.activationPolicy()) status=\(manager.status) " +
                "failure=\(manager.lastFailureReason ?? "none") log=\(manager.log.suffix(2048))"))
        #expect(try await GatewayConnection.shared.healthOK())
        #expect(AppDefaults.standard.data(forKey: postAppUpdateReceiptKey) == nil)
        manager.stop()
        await manager.waitForStartupAttempt()
        try #require(manager.status == .stopped && manager.lastFailureReason == nil)
        try #require(GatewayLaunchAgentManager.launchdProgramArguments() == [])
        let stoppedService = try #require(
            try await GatewayLaunchAgentManager.loadedGatewayState(port: GatewayEnvironment.gatewayPort()))
        try #require(stoppedService.runningPID == nil)
        await GatewayConnection.shared.shutdown()
    }

    private func updateWindow() async throws -> NSWindow {
        var window: NSWindow?
        try await TestWait.state("ordinary recovery window") {
            window = NSApp.windows.first { $0.title == "OpenClaw updated" }
            return window != nil
        }
        return try #require(window)
    }

    private func installPlugin(
        runtime: BundledRuntime, state: URL, environment: [String: String]) async throws
    {
        let package = state.appendingPathComponent("fixture-source/package")
        try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [
            "name": self.pluginID, "version": "1.0.0", "type": "module",
            "peerDependencies": ["openclaw": "*"], "openclaw": ["extensions": ["./index.js"]],
        ]).write(to: package.appendingPathComponent("package.json"))
        try JSONSerialization.data(withJSONObject: [
            "id": self.pluginID, "contracts": ["tools": ["composition_probe"]],
            "configSchema": ["type": "object", "properties": [String: Any](), "additionalProperties": false],
        ]).write(to: package.appendingPathComponent("openclaw.plugin.json"))
        try """
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        require('openclaw/plugin-sdk/plugin-entry');
        export default { id: '\(self.pluginID)', register(api) {
          api.registerTool({name:'composition_probe',label:'Composition proof',description:'Synthetic recovery proof',
            parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ready'}]})});
        }};
        """.write(to: package.appendingPathComponent("index.js"), atomically: true, encoding: .utf8)
        try """
        import { createRequire } from 'node:module';
        const require = createRequire(import.meta.url);
        require('openclaw/plugin-sdk/plugin-entry');
        console.log(require.resolve('openclaw/plugin-sdk/plugin-entry'));
        """.write(to: package.appendingPathComponent("peer-health.mjs"), atomically: true, encoding: .utf8)
        let archive = state.appendingPathComponent("fixture-plugin.tgz")
        let packed = await ShellExecutor.runDetailed(
            command: ["/usr/bin/tar", "-czf", archive.path, "-C", package.deletingLastPathComponent().path, "package"],
            cwd: nil,
            env: [:],
            timeout: 30)
        #expect(packed.success)
        let installed = await ShellExecutor.runDetailed(
            command: runtime.cliCommand + ["plugins", "install", archive.path, "--force", "--accept-capabilities"],
            cwd: runtime.packageRoot.path,
            env: environment,
            timeout: CLIInstaller.managedUpdateTimeout)
        #expect(installed.success)
    }
}
