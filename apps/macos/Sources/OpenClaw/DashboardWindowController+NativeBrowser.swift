import Foundation
import WebKit

extension DashboardWindowController {
    func receiveBrowserMessage(
        _ message: WKScriptMessage,
        replyHandler: @escaping DashboardBrowserMessageHandler.ReplyHandler)
    {
        guard message.name == DashboardBrowserMessageHandler.name,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              self.canUseBrowserDocument(sourceID: self.notificationSourceID)
        else {
            replyHandler(["ok": false, "error": DashboardBrowserError.unavailable.localizedDescription], nil)
            return
        }
        do {
            let request = try DashboardBrowserMessageHandler.decode(message.body)
            switch request {
            case let .open(tabId, url, sessionKey, _):
                // Activation is presentation owned by the requesting web panel.
                let openedTabId = try self.nativeBrowser.open(tabId: tabId, url: url, sessionKey: sessionKey)
                replyHandler(["ok": true, "tabId": openedTabId], nil)
                return
            case let .navigate(tabId, url):
                try self.nativeBrowser.navigate(tabId: tabId, url: url)
            case let .action(.download, tabId):
                self.performBrowserRequest(replyHandler: replyHandler) { browser, isCurrent in
                    let cancelled = try await browser.download(tabId: tabId, isCurrent: isCurrent)
                    return ["ok": true, "cancelled": cancelled]
                }
                return
            case let .action(.snapshot, tabId):
                self.performBrowserRequest(replyHandler: replyHandler) { browser, _ in
                    try await browser.snapshot(tabId: tabId)
                }
                return
            case let .action(action, tabId):
                try self.nativeBrowser.perform(action, tabId: tabId)
            case let .present(scope, tabId, rect, visible):
                try self.nativeBrowser.present(scope: scope, tabId: tabId, rect: rect, visible: visible)
            case let .releaseScope(scope):
                self.nativeBrowser.releaseScope(scope)
            case let .inspect(tabId, x, y):
                self.performBrowserRequest(replyHandler: replyHandler) { browser, _ in
                    try await browser.inspect(tabId: tabId, x: x, y: y)
                }
                return
            }
            replyHandler(["ok": true], nil)
        } catch {
            replyHandler(["ok": false, "error": error.localizedDescription], nil)
        }
    }

    func publishBrowserState(_ state: DashboardBrowserState) {
        guard self.canUseBrowserDocument(sourceID: self.notificationSourceID),
              let data = try? JSONEncoder().encode(state), let json = String(data: data, encoding: .utf8)
        else { return }
        let script = """
        window.__OPENCLAW_NATIVE_BROWSER__ = \(json);
        window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", {
          detail: window.__OPENCLAW_NATIVE_BROWSER__
        }));
        """
        // The JavaScript guard rechecks the destination if a sign-in redirect
        // commits between this call and WebKit's queued main-frame evaluation.
        self.webView.evaluateJavaScript(ControlUIDocumentHost.scopedDashboardScript(script, url: self.currentURL))
    }

    private func canUseBrowserDocument(sourceID: String) -> Bool {
        self.window != nil && !self.isHiddenForExperience && self.canDeliverNativeCommands &&
            self.notificationSourceID == sourceID && self.documentHost.hasCurrentBrowserSession &&
            ControlUIDocumentHost.isTrustedLinkSource(self.webView.url, dashboardURL: self.currentURL)
    }

    private func performBrowserRequest(
        replyHandler: @escaping DashboardBrowserMessageHandler.ReplyHandler,
        operation: @escaping @MainActor (
            DashboardNativeBrowserHost, @escaping @MainActor () -> Bool) async throws -> [String: Any])
    {
        let sourceID = self.notificationSourceID
        Task { @MainActor [weak self] in
            do {
                guard let self, self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                let reply = try await operation(self.nativeBrowser) { [weak self] in
                    self?.canUseBrowserDocument(sourceID: sourceID) == true
                }
                guard self.canUseBrowserDocument(sourceID: sourceID) else {
                    throw DashboardBrowserError.unavailable
                }
                replyHandler(reply, nil)
            } catch {
                replyHandler(["ok": false, "error": error.localizedDescription], nil)
            }
        }
    }
}
