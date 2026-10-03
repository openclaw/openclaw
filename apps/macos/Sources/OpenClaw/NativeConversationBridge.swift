import AppKit
import Foundation
import Observation
import OpenClawKit
import WebKit

@MainActor
final class NativeConversationMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: NativeConversationBridge?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard let owner else {
            replyHandler(["ok": false, "error": "stale-document"], nil)
            return
        }
        owner.receive(
            message,
            replyHandler: replyHandler)
    }
}

@MainActor
@Observable
final class NativeConversationBridge: NSObject, WKNavigationDelegate, WKUIDelegate {
    enum Availability: Equatable {
        case loading
        case ready
        case unsupported
        case failed(String)
    }

    let document: ControlUIDocumentHost
    private(set) var availability = Availability.loading
    private(set) var currentDocumentId: String?
    private(set) var state: NativeConversationState?
    private(set) var capabilities: Set<String> = []
    private(set) var sessionFacts: NativeConversationSessionFacts?
    var onReady: (() -> Void)?
    var onState: ((NativeConversationState) -> Void)?
    var onSessionFacts: ((NativeConversationSessionFacts) -> Void)?
    var onRouteChanged: ((NativeConversationRouteChanged) -> Void)?
    var onOpenDashboard: ((NativeConversationDashboardRoute) -> Bool)?
    var onUnavailable: ((Availability) -> Void)?
    var onDocumentRetired: (() -> Void)?
    @ObservationIgnored private var readyTimeout: Task<Void, Never>?
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var shutdownRetainer: NativeConversationBridge?
    @ObservationIgnored private var shutdownCompletions: [@MainActor () -> Void] = []
    private var isClosing = false
    private var hasShutDown = false
    private var processHasTerminated = false

    private struct Pending {
        let command: NativeConversationCommand
        let continuation: CheckedContinuation<NativeConversationResult, Never>
        let timeout: Task<Void, Never>
    }

    init(document: ControlUIDocumentHost) {
        self.document = document
        super.init()
        document.isNativeAuthAvailable = { [weak self] in
            guard let self else { return false }
            guard !self.isClosing else { return false }
            switch self.availability {
            case .loading, .ready: return true
            case .unsupported, .failed: return false
            }
        }
        document.webView.navigationDelegate = self
        document.webView.uiDelegate = self
        document.onAuthenticationFailure = { [weak self] error in
            self?.fail(error.localizedDescription)
        }
    }

    func load(_ url: URL) {
        guard !self.isClosing else { return }
        self.retireDocument()
        self.availability = .loading
        self.armReadyTimeout()
        self.document.load(url)
    }

    func close(afterShutdown completion: @escaping @MainActor () -> Void = {}) {
        guard !self.hasShutDown else { completion()
            return
        }
        self.shutdownCompletions.append(completion)
        guard !self.isClosing else { return }
        self.isClosing = true
        // The window can disappear before WebKit commits the replacement. Keep the
        // delegate and send exclusion alive until the old document cannot execute.
        self.shutdownRetainer = self
        self.readyTimeout?.cancel()
        self.document.retirePendingLoad()
        self.document.webView.stopLoading()
        self.retireDocument()
        self.document.webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeConversationContract.handlerName,
            contentWorld: .page)
        self.document.webView.uiDelegate = nil
        if self.processHasTerminated { self.didShutDown()
            return
        }
        self.document.webView.loadHTMLString(
            "",
            baseURL: nil)
    }

    private func didShutDown() {
        guard self.isClosing, !self.hasShutDown else { return }
        self.hasShutDown = true
        self.document.webView.navigationDelegate = nil
        let completions = self.shutdownCompletions
        self.shutdownCompletions.removeAll()
        for completion in completions {
            completion()
        }
        self.shutdownRetainer = nil
    }

    private func armReadyTimeout() {
        self.readyTimeout?.cancel()
        self.readyTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, self.currentDocumentId == nil, self.availability == .loading else { return }
            if !self.document.hasCurrentBrowserSession || !ControlUIDocumentHost.isTrustedLinkSource(
                self.document.webView.url,
                dashboardURL: self.document.currentURL)
            {
                self.fail(String(localized: "Gateway sign-in required"))
            } else {
                self.availability = .unsupported
                self.onUnavailable?(.unsupported)
            }
        }
    }

    private func retireDocument() {
        self.document.retireDocument()
        self.currentDocumentId = nil
        self.state = nil
        self.capabilities = []
        self.sessionFacts = nil
        let requests = self.pending
        self.pending.removeAll()
        for request in requests.values {
            self.complete(request, with: Self.failure(
                for: request.command,
                error: "stale-document"))
        }
        self.onDocumentRetired?()
    }

    private func fail(_ message: String) {
        guard !self.isClosing else { return }
        self.readyTimeout?.cancel()
        self.retireDocument()
        self.availability = .failed(message)
        self.onUnavailable?(self.availability)
    }

    func receive(
        _ message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        NativeConversationTrace.receive(message.body)
        // Match JSON.stringify so slash-containing session keys share the web's byte budget.
        guard self.isTrusted(message),
              let fields = message.body as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes]),
              fields["type"] as? String != "session-facts" ||
              data.count <= NativeConversationSessionFacts.maximumBytes,
              let decoded = try? JSONDecoder().decode(
                  NativeConversationMessage.self,
                  from: data)
        else {
            replyHandler(["ok": false, "error": "unsupported"], nil)
            return
        }
        let generation = self.document.generation
        if case let .ready(ready) = decoded.body {
            Task { @MainActor [weak self] in
                guard let self else {
                    replyHandler(["ok": false, "error": "stale-document"], nil)
                    return
                }
                let script = ControlUIDocumentHost.scopedDashboardScript(
                    "return \(NativeConversationContract.documentProbe);",
                    url: self.document.currentURL)
                let probe = try? await self.document.webView.evaluateJavaScript(script)
                guard self.document.generation == generation, self.isTrusted(message),
                      probe as? String == decoded.documentId
                else {
                    replyHandler(["ok": false, "error": "stale-document"], nil)
                    return
                }
                // A duplicate ready does not reset monotonic state or pending requests.
                if self.currentDocumentId != decoded.documentId {
                    guard self.currentDocumentId == nil else {
                        replyHandler(["ok": false, "error": "stale-document"], nil)
                        return
                    }
                    self.currentDocumentId = decoded.documentId
                    self.capabilities = Set(ready.capabilities)
                    self.readyTimeout?.cancel()
                    self.availability = .ready
                    self.onReady?()
                }
                replyHandler(["ok": true], nil)
            }
            return
        }
        guard decoded.documentId == self.currentDocumentId else {
            replyHandler(["ok": false, "error": "stale-document"], nil)
            return
        }
        switch decoded.body {
        case .ready: break
        case let .state(state):
            guard self.state.map({ state.revision > $0.revision }) ?? true else {
                replyHandler(["ok": false, "error": "stale-state"], nil)
                return
            }
            self.state = state
            self.onState?(state)
        case let .sessionFacts(facts):
            guard self.capabilities.contains("session-facts-v1") else {
                replyHandler(["ok": false, "error": "unsupported"], nil)
                return
            }
            guard facts.revision > (self.sessionFacts?.revision ?? 0) else {
                replyHandler(["ok": false, "error": "stale-state"], nil)
                return
            }
            self.sessionFacts = facts
            self.onSessionFacts?(facts)
        case let .commandResult(result):
            if let request = self.pending.removeValue(forKey: result.requestId) {
                self.complete(request, with: result)
            }
        case let .routeChanged(change): self.onRouteChanged?(change)
        case let .openDashboard(route):
            guard self.onOpenDashboard?(route) == true else {
                replyHandler(["ok": false, "error": "invalid-route"], nil)
                return
            }
        }
        replyHandler(["ok": true], nil)
    }

    private func isTrusted(_ message: WKScriptMessage) -> Bool {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        return !self.isClosing && message.name == NativeConversationContract.handlerName &&
            message.webView === self.document.webView &&
            frame.isMainFrame && self.document.hasCurrentBrowserSession &&
            ControlUIDocumentHost.isTrustedLinkSource(
                frame.request.url,
                dashboardURL: self.document.currentURL) &&
            ControlUIDocumentHost.isTrustedLinkSource(
                self.document.webView.url,
                dashboardURL: self.document.currentURL) &&
            ControlUIDocumentHost.isTrustedMediaCaptureOrigin(
                protocol: origin.protocol,
                host: origin.host,
                port: origin.port,
                dashboardURL: self.document.currentURL)
    }

    func request(
        _ action: NativeConversationCommand.Action) async
        -> NativeConversationResult
    {
        let command = NativeConversationCommand(
            documentId: self.currentDocumentId ?? "",
            requestId: UUID().uuidString,
            action: action)
        NativeConversationTrace.command(command)
        if case .openSessionActions = action, !self.capabilities.contains("session-actions-v1") {
            return Self.failure(for: command, error: "unsupported")
        }
        guard self.currentDocumentId != nil, self.document.hasCurrentBrowserSession,
              let script = try? command.javaScript()
        else {
            let result = Self.failure(
                for: command,
                error: "stale-document")
            NativeConversationTrace.result(command, result: result)
            return result
        }
        let generation = self.document.generation
        return await withCheckedContinuation { continuation in
            let timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                self?.reject(
                    command.requestId,
                    error: "timeout")
            }
            self.pending[command.requestId] = Pending(
                command: command,
                continuation: continuation,
                timeout: timeout)
            self.document.webView.evaluateJavaScript(ControlUIDocumentHost.scopedDashboardScript(
                "return \(script);",
                url: self.document.currentURL))
            { [weak self] result, error in
                guard let self else { return }
                if self.document.generation != generation || error != nil || result as? Bool != true {
                    self.reject(
                        command.requestId,
                        error: "stale-document")
                }
            }
        }
    }

    private func reject(
        _ requestId: String,
        error: String)
    {
        guard let request = self.pending.removeValue(forKey: requestId) else { return }
        self.complete(request, with: Self.failure(for: request.command, error: error))
    }

    private func complete(_ request: Pending, with result: NativeConversationResult) {
        request.timeout.cancel()
        NativeConversationTrace.result(request.command, result: result)
        request.continuation.resume(returning: result)
    }

    private static func failure(
        for command: NativeConversationCommand,
        error: String) -> NativeConversationResult
    {
        NativeConversationResult(
            requestId: command.requestId,
            ok: false,
            error: error)
    }

    func webView(_ webView: WKWebView, didCommit _: WKNavigation!) {
        guard webView === self.document.webView else { return }
        if self.isClosing {
            if webView.url?.absoluteString == "about:blank" {
                self.didShutDown()
            }
            return
        }
        self.processHasTerminated = false
        self.retireDocument()
        self.availability = .loading
        self.armReadyTimeout()
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        guard webView === self.document.webView else { return }
        self.document.hasLiveContent = true
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: Error) {
        guard webView === self.document.webView else { return }
        let failure = error as NSError
        guard failure.domain != NSURLErrorDomain || failure.code != NSURLErrorCancelled else { return }
        self.fail(error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(
            webView,
            didFail: navigation,
            withError: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.document.webView else { return }
        self.processHasTerminated = true
        if self.isClosing { self.didShutDown()
            return
        }
        self.fail(String(localized: "The conversation page stopped. Reopen the window to reconnect."))
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 400
        {
            self.fail(HTTPURLResponse.localizedString(forStatusCode: response.statusCode))
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        if self.isClosing {
            decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
            return
        }
        self.document.decidePolicy(
            for: navigationAction,
            documentReady: self.currentDocumentId != nil,
            decisionHandler: decisionHandler)
    }

    func webView(
        _: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        self.document.authenticationChallenge(
            challenge,
            completionHandler: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void)
    {
        self.document.confirm(
            message: message,
            host: frame.request.url?.host,
            parent: webView.window,
            completionHandler: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame _: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        ControlUIDocumentHost.openPanel(
            parameters: parameters,
            parent: webView.window,
            completionHandler: completionHandler)
    }

    func webView(
        _: WKWebView,
        createWebViewWith _: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures _: WKWindowFeatures) -> WKWebView?
    {
        if case let .openExternal(url) = ControlUIDocumentHost.newWindowAction(
            for: navigationAction.request.url,
            sourceIsNativeReadingTab: false)
        {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
