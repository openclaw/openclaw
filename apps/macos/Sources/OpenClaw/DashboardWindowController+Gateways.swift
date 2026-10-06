import AppKit
import Foundation
import OpenClawKit
import WebKit

enum DashboardGatewaysRequest: Equatable {
    case select(DashboardGatewayTarget)
    case openWindow(DashboardGatewayTarget)
    case setPrimary(DashboardGatewayTarget)
    case reconnect(DashboardGatewayTarget)
    case reconnectCancel(DashboardGatewayTarget)
    case reconnectBrowser(DashboardGatewayTarget, UUID)
    case openSettings
}

extension DashboardWindowController {
    static let gatewaysMessageHandlerName = "openclawGateways"

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?) -> Void)
    {
        guard webView === self.webView else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        self.documentHost.authenticationChallenge(challenge, completionHandler: completionHandler)
    }

    static func gatewaysRequest(from body: Any) -> DashboardGatewaysRequest? {
        guard let payload = body as? [String: Any], let type = payload["type"] as? String else {
            return nil
        }
        if type == "open-settings" { return .openSettings }
        guard let id = payload["id"] as? String,
              let target = DashboardGatewayTarget(bridgeID: id)
        else {
            return nil
        }
        if type == "reconnect-browser" {
            guard let rawAttempt = payload["attempt"] as? String,
                  let attempt = UUID(uuidString: rawAttempt) else { return nil }
            return .reconnectBrowser(target, attempt)
        }
        return switch type {
        case "select": .select(target)
        case "open-window": .openWindow(target)
        case "set-primary": .setPrimary(target)
        case "reconnect": .reconnect(target)
        case "reconnect-cancel": .reconnectCancel(target)
        default: nil
        }
    }

    func receiveGatewaysMessage(_ message: WKScriptMessage) {
        guard message.name == Self.gatewaysMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame
        else {
            return
        }
        if let payload = message.body as? [String: Any],
           payload["type"] as? String == "connection-state-changed"
        {
            guard ControlUIDocumentHost
                .isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL) else { return }
            self.refreshGatewayHealth()
            return
        }
        guard let request = Self.gatewaysRequest(from: message.body) else { return }
        let isSignedOutAction = self.signedOut.map { page in
            if case let .reconnectBrowser(target, _) = request { return target == page.target }
            return request == .reconnect(page.target) || request == .reconnectCancel(page.target)
        } ?? false
        let isSignedOutDocument = self.isShowingFailurePage && isSignedOutAction &&
            message.frameInfo.request.url?.absoluteString == "about:blank" &&
            self.webView.url?.absoluteString == "about:blank"
        // The recovery capability belongs to the native failure document, never a loaded Gateway page.
        if case .reconnectBrowser = request, !isSignedOutDocument { return }
        guard isSignedOutDocument ||
            ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL)
        else { return }
        DashboardManager.shared.handleGatewayRequest(request, from: self)
    }

    func updateGatewaySnapshot(_ snapshot: DashboardGatewaySnapshot) {
        self.gatewaySnapshot = snapshot
        self.refreshNativeScripts()
        self.webView.evaluateJavaScript(ControlUIDocumentHost.scopedDashboardScript(
            Self.nativeGatewaysScriptSource(snapshot: snapshot, dispatch: true), url: self.currentURL))
    }

    static func installNativeGatewaysScript(
        into userContentController: WKUserContentController,
        url: URL,
        snapshot: DashboardGatewaySnapshot?)
    {
        let snapshotScript = snapshot.map { self.nativeGatewaysScriptSource(snapshot: $0, dispatch: false) } ?? ""
        userContentController.addUserScript(WKUserScript(
            source: ControlUIDocumentHost.scopedDashboardScript(
                """
                \(snapshotScript)
                window.addEventListener('openclaw:native-gateway-health-changed', () => {
                  window.webkit.messageHandlers.openclawGateways.postMessage({type: 'connection-state-changed'});
                });
                """, url: url),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    static func nativeGatewaysScriptSource(
        snapshot: DashboardGatewaySnapshot,
        dispatch: Bool) -> String
    {
        guard let data = try? JSONEncoder().encode(snapshot) else { return "" }
        let json = String(bytes: data, encoding: .utf8)!
        let event = dispatch
            ? "window.dispatchEvent(new CustomEvent('openclaw:native-gateways-changed'," +
            "{detail:window.__OPENCLAW_NATIVE_GATEWAYS__}));"
            : ""
        return "window.__OPENCLAW_NATIVE_GATEWAYS__=\(json);\(event)"
    }

    static func makeSetPrimaryAlert(gatewayName: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "Set \(gatewayName) as primary?"
        alert.informativeText =
            "This changes the Mac app's primary Gateway and resets its Talk Mode, canvas, " +
            "and native chat connection. " +
            "Other saved Gateway windows stay open."
        alert.addButton(withTitle: "Set as Primary")
        alert.addButton(withTitle: "Cancel")
        return alert
    }

    static func makeGatewaySetupAlert(title: String, message: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Change Gateway")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert
    }
}
