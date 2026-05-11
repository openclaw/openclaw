import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import WebKit

final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "openclawCanvasA2UIAction"
    static let allMessageNames = [messageName]

    /// Compatibility helper for debug/test shims. Runtime dispatch remains
    /// limited to in-app canvas schemes in `didReceive`.
    static func isLocalNetworkCanvasURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.lowercased(), !host.isEmpty else {
            return false
        }
        if host == "localhost" {
            return true
        }
        guard let ip = Self.parseIPv4(host) else {
            return false
        }
        return Self.isLocalNetworkIPv4(ip)
    }

    private let sessionKey: String
    private weak var liveThomasWebView: WKWebView?

    private lazy var realtimeBridge = CanvasRealtimeTalkBridge(
        request: { method, paramsJSON, timeoutSeconds in
            let isLocal = await MainActor.run {
                AppStateStore.shared.connectionMode == .local
            }
            if isLocal {
                await GatewayProcessManager.shared.setActive(true)
            }
            let params: [String: AnyCodable]? = Self.decodeParamsJSON(paramsJSON)
            return try await GatewayConnection.shared.request(
                method: method,
                params: params,
                timeoutMs: Double(timeoutSeconds * 1000))
        },
        events: {
            let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 200)
            return AsyncStream { continuation in
                let task = Task {
                    for await push in stream {
                        guard !Task.isCancelled else { break }
                        if case let .event(event) = push {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                }
                continuation.onTermination = { _ in
                    task.cancel()
                }
            }
        },
        onStatus: { [weak self] status in
            await MainActor.run {
                self?.dispatchLiveThomasStatus(status)
            }
        })

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        super.init()
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Self.allMessageNames.contains(message.name) else { return }

        // Only accept actions from the in-app canvas scheme. Local-network HTTP
        // pages are regular web content and must not get direct agent dispatch.
        guard let webView = message.webView, let url = webView.url else { return }
        guard let scheme = url.scheme, CanvasScheme.allSchemes.contains(scheme) else {
            return
        }

        let body: [String: Any] = {
            if let dict = message.body as? [String: Any] { return dict }
            if let dict = message.body as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !body.isEmpty else { return }

        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = OpenClawCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId =
            (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? UUID().uuidString

        canvasWindowLogger.info("A2UI action \(name, privacy: .public) session=\(self.sessionKey, privacy: .public)")

        if OpenClawCanvasA2UIAction.isTalkRealtimeActionName(name) {
            self.handleTalkRealtimeAction(name: name, userAction: userAction, actionId: actionId, webView: webView)
            return
        }

        let surfaceId = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? "main"
        let sourceComponentId = (userAction["sourceComponentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "-"
        let instanceId = InstanceIdentity.instanceId.lowercased()
        let contextJSON = OpenClawCanvasA2UIAction.compactJSON(userAction["context"])

        // Token-efficient and unambiguous. The agent should treat this as a UI event and (by default) update Canvas.
        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: self.sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: InstanceIdentity.displayName, instanceId: instanceId),
            contextJSON: contextJSON)
        let text = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

        Task { [weak webView] in
            if AppStateStore.shared.connectionMode == .local {
                GatewayProcessManager.shared.setActive(true)
            }

            let result = await GatewayConnection.shared.sendAgent(
                GatewayAgentInvocation(
                    message: text,
                    sessionKey: self.sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: .last,
                    idempotencyKey: actionId))

            await MainActor.run {
                guard let webView else { return }
                let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
                    actionId: actionId,
                    ok: result.ok,
                    error: result.error)
                webView.evaluateJavaScript(js) { _, _ in }
            }
            if !result.ok {
                canvasWindowLogger.error(
                    """
                    A2UI action send failed name=\(name, privacy: .public) \
                    error=\(result.error ?? "unknown", privacy: .public)
                    """)
            }
        }
    }

    private func handleTalkRealtimeAction(
        name _: String,
        userAction _: [String: Any],
        actionId: String,
        webView: WKWebView)
    {
        Task { [weak self, weak webView] in
            guard let self, let webView else { return }
            self.liveThomasWebView = webView
            let status = await self.realtimeBridge.toggle(sessionKey: self.sessionKey)
            await MainActor.run {
                let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
                    actionId: actionId,
                    ok: status.ok,
                    error: status.ok ? nil : status.message,
                    state: status.state,
                    message: status.message)
                webView.evaluateJavaScript(js) { _, _ in }
            }
        }
    }

    @MainActor
    private func dispatchLiveThomasStatus(_ status: CanvasRealtimeTalkStatus) {
        guard let webView = self.liveThomasWebView else { return }
        let js = OpenClawCanvasA2UIAction.jsDispatchLiveThomasStatus(status)
        webView.evaluateJavaScript(js) { _, _ in }
    }

    nonisolated private static func decodeParamsJSON(_ json: String?) -> [String: AnyCodable]? {
        let trimmed = json?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: AnyCodable].self, from: data)
    }

    private static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    private static func isLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        if a == 10 { return true }
        if a == 172, (16...31).contains(Int(b)) { return true }
        if a == 192, b == 168 { return true }
        if a == 127 { return true }
        if a == 169, b == 254 { return true }
        if a == 100, (64...127).contains(Int(b)) { return true }
        return false
    }
    // Formatting helpers live in OpenClawKit (`OpenClawCanvasA2UIAction`).
}
