import AppKit
import Foundation
import OSLog

@MainActor
final class CLIInstallPrompter {
    static let shared = CLIInstallPrompter()
    private let logger = Logger(subsystem: "com.clawdbot", category: "cli.prompt")
    private var isPrompting = false

    func checkAndPromptIfNeeded(reason: String) {
        guard self.shouldPrompt() else { return }
        guard let version = Self.appVersion() else { return }
        self.isPrompting = true
        UserDefaults.standard.set(version, forKey: cliInstallPromptedVersionKey)

        let alert = NSAlert()
        alert.messageText = "Install Clawdbot CLI?"
        alert.informativeText = "Local mode needs the CLI so launchd can run the gateway."
        alert.addButton(withTitle: "Install CLI")
        alert.addButton(withTitle: "Not now")
        alert.addButton(withTitle: "Open Settings")
        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            Task { await self.installCLI() }
        case .alertThirdButtonReturn:
            self.openSettings(tab: .general)
        default:
            break
        }

        self.logger.debug("cli install prompt handled reason=\(reason, privacy: .public)")
        self.isPrompting = false
    }

    private func shouldPrompt() -> Bool {
        guard !self.isPrompting else { return false }
        guard AppStateStore.shared.onboardingSeen else { return false }
        guard AppStateStore.shared.connectionMode == .local else { return false }
        guard !AppStateStore.shared.attachExistingGatewayOnly else { return false }
        guard CLIInstaller.installedLocation() == nil else { return false }
        guard let version = Self.appVersion() else { return false }
        let lastPrompt = UserDefaults.standard.string(forKey: cliInstallPromptedVersionKey)
        return lastPrompt != version
    }

    private func installCLI() async {
        var lastStatus: String?
        await CLIInstaller.install { message in
            lastStatus = message
        }
        if let message = lastStatus {
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
            NotificationCenter.default.post(name: .clawdbotSelectSettingsTab, object: tab)
        }
    }

    private static func appVersion() -> String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }
}
