import AppKit
import WebKit

extension ControlUIDocumentHost {
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
        completionHandler(Self.javaScriptConfirmResult(for: alert.runModal()))
    }

    static func openPanel(
        parameters: WKOpenPanelParameters,
        parent: NSWindow?,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
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
