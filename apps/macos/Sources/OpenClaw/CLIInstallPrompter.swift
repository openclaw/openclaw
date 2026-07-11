import AppKit
import Foundation
import OSLog

@MainActor
final class CLIInstallPrompter {
    static let shared = CLIInstallPrompter()
    private let logger = Logger(subsystem: "ai.openclaw", category: "cli.prompt")
    private var isPrompting = false

    func checkAndPromptIfNeeded(reason: String) {
        guard !self.isPrompting else { return }
        self.isPrompting = true
        Task { @MainActor in
            await self.checkAndPromptIfNeededAsync(reason: reason)
            self.isPrompting = false
        }
    }

    private func checkAndPromptIfNeededAsync(reason: String) async {
        guard AppStateStore.shared.onboardingSeen else { return }
        guard AppStateStore.shared.connectionMode == .local else { return }
        guard let version = Self.appVersion() else { return }
        let status = await CLIInstaller.status()
        guard AppStateStore.shared.onboardingSeen else { return }
        guard AppStateStore.shared.connectionMode == .local else { return }
        guard !status.isReady else { return }
        let lastPrompt = UserDefaults.standard.string(forKey: cliInstallPromptedVersionKey)
        guard lastPrompt != version else { return }
        UserDefaults.standard.set(version, forKey: cliInstallPromptedVersionKey)

        let alert = NSAlert()
        alert.messageText = "Install OpenClaw CLI?"
        alert.informativeText = "Local mode needs the CLI so launchd can run the gateway."
        alert.addButton(withTitle: "Install CLI")
        alert.addButton(withTitle: "Not now")
        alert.addButton(withTitle: "Open Settings")
        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            Task { await self.installCLI() }
        case .alertThirdButtonReturn:
            self.openSettings(tab: .connection)
        default:
            break
        }

        self.logger.debug("cli install prompt handled reason=\(reason, privacy: .public)")
    }

    private func installCLI() async {
        let status = StatusBox()
        let installed = await CLIInstaller.install { message in
            await status.set(message)
        }
        if installed {
            await status.set("Starting OpenClaw Gateway…")
            let activation = await CLIInstaller.activateLocalGateway()
            let message = switch activation {
            case .ready:
                "OpenClaw Gateway is ready."
            case .deferred:
                "OpenClaw is installed. The Gateway will start when This Mac is active and resumed."
            case .failed:
                "OpenClaw was installed, but the Gateway did not start. Open Settings to retry."
            }
            await status.set(message)
        }
        if let message = await status.get() {
            let alert = NSAlert()
            alert.messageText = "CLI install finished"
            alert.informativeText = message
            alert.runModal()
        }
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    private static func appVersion() -> String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }
}

private actor StatusBox {
    private var value: String?

    func set(_ value: String) {
        self.value = value
    }

    func get() -> String? {
        self.value
    }
}
