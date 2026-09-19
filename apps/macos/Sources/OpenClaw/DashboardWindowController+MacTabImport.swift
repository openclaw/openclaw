import AppKit
import Foundation

extension DashboardWindowController {
    func importChromeLoginsIntoMacTabs() async {
        let sourceID = self.notificationSourceID
        guard self.canUseDeviceSettings(sourceID: sourceID) else { return }
        let profiles = MacTabChromeCookies.profiles()
        guard !profiles.isEmpty else {
            self.presentMacTabImportResult(MacTabChromeCookies.ImportError.unavailable.localizedDescription)
            return
        }
        guard let profile = await self.deviceSettingsMessageHandler.chooseMacTabChromeProfile(
            profiles, persistent: self.nativeBrowser.usesPersistentCookieStore),
            self.canUseDeviceSettings(sourceID: sourceID) else { return }
        do {
            // SQLite and the potentially interactive Keychain read must not block
            // AppKit. Cancellation retires the read and prevents subsequent writes.
            let task = Task.detached { try MacTabChromeCookies.read(profile) }
            let batch = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            guard self.canUseDeviceSettings(sourceID: sourceID) else { return }
            let result = try await self.nativeBrowser.importChromeCookies(
                batch, protectedHost: self.currentURL.host,
                isCurrent: { self.canUseDeviceSettings(sourceID: sourceID) })
            guard self.canUseDeviceSettings(sourceID: sourceID) else { return }
            self.presentMacTabImportResult(String(
                format: String(localized: """
                %lld of %lld cookies imported into this window's Mac tabs. %lld skipped; %lld failed. \
                Reload an existing tab to use its imported login; new tabs use it automatically. \
                Some sites require a fresh sign-in. No passwords or passkeys were imported.
                """), result.imported, result.total, result.skipped, result.failed))
        } catch is CancellationError {
            return
        } catch {
            guard self.canUseDeviceSettings(sourceID: sourceID) else { return }
            // Only fixed local error messages leave the reader. Never show SQL,
            // Keychain diagnostics, cookie names/values, or decryption payloads.
            let message = (error as? MacTabChromeCookies.ImportError)?.localizedDescription
                ?? MacTabChromeCookies.ImportError.database.localizedDescription
            self.presentMacTabImportResult(message)
        }
    }

    private func presentMacTabImportResult(_ message: String) {
        guard let window = self.window, self.isWindowOpen, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = String(localized: "Mac tab login import")
        alert.informativeText = message
        alert.addButton(withTitle: String(localized: "OK"))
        alert.beginSheetModal(for: window, completionHandler: nil)
    }
}
