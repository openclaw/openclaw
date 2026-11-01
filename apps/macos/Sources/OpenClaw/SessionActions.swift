import AppKit
import Foundation

enum SessionActions {
    @MainActor
    static func confirmDestructiveAction(title: String, message: String, action: String) async -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return await AppActivation.shared.response(to: alert) == .alertFirstButtonReturn
    }

    @MainActor
    static func presentError(title: String, error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .warning
        AppActivation.shared.presentAlert(alert)
    }

    @MainActor
    static func openSessionLogInCode(sessionId: String, storePath: String?) {
        var candidates: [URL] = []
        if let storePath, !storePath.isEmpty {
            let dir = URL(fileURLWithPath: storePath).deletingLastPathComponent()
            candidates.append(dir.appendingPathComponent("\(sessionId).jsonl"))
        }
        candidates.append(OpenClawPaths.stateDirURL.appendingPathComponent("sessions/\(sessionId).jsonl"))

        let existing = candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
        guard let url = existing else {
            let alert = NSAlert()
            alert.messageText = "Session log not found"
            alert.informativeText = sessionId
            AppActivation.shared.presentAlert(alert)
            return
        }

        guard AppActivation.shared.requestExternalNavigation() else { return }
        guard let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode")
        else {
            AppActivation.shared.revealFiles([url])
            return
        }
        AppActivation.shared.open([url], withApplicationAt: applicationURL) { _, error in
            guard error != nil else { return }
            Task { @MainActor in AppActivation.shared.revealFiles([url]) }
        }
    }
}
