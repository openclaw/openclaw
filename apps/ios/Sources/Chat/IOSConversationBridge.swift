import Foundation
import Observation
import OpenClawKit
import WebKit

/// iPad adapter for the same document-bound conversation contract as macOS.
/// Authentication, TLS and navigation remain with AuthenticatedControlUIWebView.
@MainActor
@Observable
final class IOSConversationBridge: NSObject, WKScriptMessageHandlerWithReply {
    private(set) var documentID: String?
    private(set) var state: NativeConversationState?
    private(set) var facts: NativeConversationSessionFacts?
    private(set) var ready = false
    private var capabilities: Set<String> = []
    @ObservationIgnored weak var webView: WKWebView?
    @ObservationIgnored var onReady: (() -> Void)?
    @ObservationIgnored var onState: ((NativeConversationState) -> Void)?
    @ObservationIgnored var onFacts: ((NativeConversationSessionFacts) -> Void)?
    @ObservationIgnored var onRoute: ((NativeConversationContext) -> Void)?
    @ObservationIgnored var onDashboard: ((NativeConversationDashboardRoute) -> Bool)?
    @ObservationIgnored var onFailure: (() -> Void)?
    @ObservationIgnored var isCurrent: () -> Bool = { false }
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var deadline: Task<Void, Never>?
    @ObservationIgnored private var pending: [String: CheckedContinuation<Bool, Never>] = [:]
    @ObservationIgnored private var shutdowns: [() -> Void] = []
    let url: URL
    private let gatewayURL: URL

    init(url: URL, gatewayURL: URL) {
        self.url = url
        self.gatewayURL = gatewayURL
    }

    var hostScript: String? {
        guard let data = try? JSONSerialization.data(withJSONObject: OpenClawSidebarPalette.conversationTheme),
              let appearance = String(data: data, encoding: .utf8) else { return nil }
        return IOSDeviceSettingsBridge.originGatedScript(
            """
            window.__OPENCLAW_NATIVE_EMBED__ = {
              platform: "ios", formFactor: "pad", surface: "conversation", appearance: \(appearance)
            };
            window.__OPENCLAW_NATIVE_CONVERSATION__ = {
              contract: 1, features: ["session-facts-v1", "session-actions-v1"]
            };
            """, url: self.url)
    }

    func attach(_ webView: WKWebView) {
        self.webView = webView
        self.armDeadline()
    }

    func didCommit() {
        if self.isClosing, self.webView?.url?.absoluteString == "about:blank" {
            self.didShutDown()
            return
        }
        self.retire()
        self.armDeadline()
    }

    func retire() {
        self.generation = UUID()
        self.documentID = nil
        self.ready = false
        self.state = nil
        self.facts = nil
        self.capabilities = []
        self.deadline?.cancel()
        let requests = self.pending.values
        self.pending.removeAll()
        for request in requests {
            request.resume(returning: false)
        }
    }

    private func armDeadline() {
        self.deadline?.cancel()
        self.deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, !self.ready, !self.isClosing else { return }
            self.onFailure?()
        }
    }

    /// Keep send exclusion until the old executable document is gone.
    func close(afterShutdown: @escaping () -> Void) {
        guard let webView else { afterShutdown()
            return
        }
        let wasClosing = self.isClosing
        self.shutdowns.append(afterShutdown)
        guard !wasClosing else { return }
        self.retire()
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
    }

    func processTerminated() {
        self.retire()
        if self.isClosing {
            self.didShutDown()
        } else {
            self.onFailure?()
        }
    }

    private func didShutDown() {
        self.webView = nil
        let callbacks = self.shutdowns
        self.shutdowns.removeAll()
        for callback in callbacks {
            callback()
        }
    }

    var isClosing: Bool {
        !self.shutdowns.isEmpty
    }

    private func trusted(_ message: WKScriptMessage) -> Bool {
        let origin = message.frameInfo.securityOrigin
        return !self.isClosing && self.isCurrent() &&
            message.name == NativeConversationContract.handlerName &&
            GatewayTLSAuthority(url: self.url)?.matches(host: origin.host, port: origin.port) == true &&
            origin.protocol == self.url.scheme &&
            IOSDeviceSettingsBridge.isTrustedSource(
                message.frameInfo.request.url,
                webViewURL: self.webView?.url,
                // The protected entry replaces its URL with the canonical chat
                // path before app scripts run. Trust the authenticated mount,
                // not the private entry endpoint used only to load the document.
                gatewayURL: self.gatewayURL,
                isMainFrame: message.frameInfo.isMainFrame,
                isHostingWebView: message.webView != nil && message.webView === self.webView)
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard self.trusted(message), let fields = message.body as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: fields, options: [.withoutEscapingSlashes]),
              fields["type"] as? String != "session-facts" || data.count <= NativeConversationSessionFacts.maximumBytes,
              let decoded = try? JSONDecoder().decode(NativeConversationMessage.self, from: data)
        else { replyHandler(["ok": false, "error": "unsupported"], nil)
            return
        }
        if case let .ready(ready) = decoded.body {
            let generation = self.generation
            Task { [weak self] in
                guard let self, let webView = self.webView else {
                    replyHandler(["ok": false, "error": "stale-document"], nil)
                    return
                }
                let probe = try? await webView.evaluateJavaScript(NativeConversationContract.documentProbe)
                guard generation == self.generation, self.trusted(message),
                      probe as? String == decoded.documentId,
                      self.documentID == nil || self.documentID == decoded.documentId
                else {
                    replyHandler(["ok": false, "error": "stale-document"], nil)
                    return
                }
                if self.documentID == nil {
                    self.documentID = decoded.documentId
                    self.capabilities = Set(ready.capabilities)
                    self.ready = true
                    self.deadline?.cancel()
                    self.onReady?()
                }
                replyHandler(["ok": true], nil)
            }
            return
        }
        guard decoded.documentId == self.documentID else {
            replyHandler(["ok": false, "error": "stale-document"], nil)
            return
        }
        switch decoded.body {
        case .ready: break
        case let .state(state):
            guard state.revision > (self.state?.revision ?? 0) else {
                replyHandler(["ok": false, "error": "stale-state"], nil)
                return
            }
            self.state = state
            self.onState?(state)
        case let .routeChanged(route): self.onRoute?(NativeConversationContext(
                agentId: route.agentId, sessionKey: route.sessionKey))
        case let .sessionFacts(facts):
            guard self.capabilities.contains("session-facts-v1"), facts.revision > (self.facts?.revision ?? 0) else {
                replyHandler(["ok": false, "error": "stale-state"], nil)
                return
            }
            self.facts = facts
            self.onFacts?(facts)
        case let .commandResult(result): self.pending.removeValue(forKey: result.requestId)?
            .resume(returning: result.ok)
        case let .openDashboard(route):
            guard self.onDashboard?(route) == true else {
                replyHandler(["ok": false, "error": "invalid-route"], nil)
                return
            }
        }
        replyHandler(["ok": true], nil)
    }

    func request(_ action: NativeConversationCommand.Action) async -> Bool {
        guard let documentID, self.isCurrent(), let webView else { return false }
        let command = NativeConversationCommand(documentId: documentID, requestId: UUID().uuidString, action: action)
        guard let script = try? command.javaScript() else { return false }
        return await withCheckedContinuation { continuation in
            self.pending[command.requestId] = continuation
            Task { [weak self] in
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                self?.pending.removeValue(forKey: command.requestId)?.resume(returning: false)
            }
            webView.evaluateJavaScript(script) { [weak self] result, error in
                if error != nil || result as? Bool != true {
                    self?.pending.removeValue(forKey: command.requestId)?.resume(returning: false)
                }
            }
        }
    }
}
