import AppKit
import WebKit

extension ControlUIDocumentHost {
    static func mediaCaptureDecision(
        _ decision: WKPermissionDecision,
        launchPlan: AppLaunchRuntimePlan = .current) -> WKPermissionDecision
    {
        guard decision == .prompt, !launchPlan.allowsActivation else { return decision }
        PermissionManager.reportDeferredRequest()
        return .deny
    }

    func confirm(
        message: String,
        host: String?,
        parent: NSWindow?,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void)
    {
        let alert = Self.makeJavaScriptConfirmAlert(
            message: message,
            host: host)
        if let window = parent {
            alert.beginSheetModal(for: window) { response in
                completionHandler(Self.javaScriptConfirmResult(for: response))
            }
            return
        }
        AppActivation.shared.presentAlert(alert) { response in
            completionHandler(Self.javaScriptConfirmResult(for: response))
        }
    }

    static func openPanel(
        parameters: WKOpenPanelParameters,
        parent: NSWindow?,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        guard AppLaunchRuntimePlan.current.allowsActivation else {
            Logger(subsystem: "ai.openclaw", category: "browser").warning(
                "File selection deferred by --no-activate. Relaunch without the flag to choose a file.")
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        if let window = parent {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            return
        }
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    static func makeJavaScriptConfirmAlert(
        message: String,
        host: String?) -> NSAlert
    {
        let alert = NSAlert()
        alert.messageText = "OpenClaw Dashboard"
        if let host, !host.isEmpty {
            alert.informativeText = "\(host) is asking:\n\n\(message)"
        } else {
            alert.informativeText = message
        }
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return alert
    }

    static func javaScriptConfirmResult(
        for response: NSApplication.ModalResponse)
        -> Bool
    {
        response == .alertFirstButtonReturn
    }
}
