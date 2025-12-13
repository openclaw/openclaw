import AppKit
import ClawdisKit
import Foundation
import OSLog
import Security

private let deepLinkLogger = Logger(subsystem: "com.steipete.clawdis", category: "DeepLink")

@MainActor
final class DeepLinkHandler {
    static let shared = DeepLinkHandler()

    private var lastPromptAt: Date = .distantPast

    func handle(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else {
            deepLinkLogger.debug("ignored url \(url.absoluteString, privacy: .public)")
            return
        }
        guard UserDefaults.standard.bool(forKey: deepLinkAgentEnabledKey) else {
            self.presentAlert(
                title: "Deep links are disabled",
                message: "Enable “Allow URL scheme (agent)” in Clawdis Debug Settings to accept clawdis:// links.")
            return
        }
        guard !AppStateStore.shared.isPaused else {
            self.presentAlert(title: "Clawdis is paused", message: "Unpause Clawdis to run agent actions.")
            return
        }

        switch route {
        case let .agent(link):
            await self.handleAgent(link: link, originalURL: url)
        }
    }

    private func handleAgent(link: AgentDeepLink, originalURL: URL) async {
        let messagePreview = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if messagePreview.count > 20000 {
            self.presentAlert(title: "Deep link too large", message: "Message exceeds 20,000 characters.")
            return
        }

        let allowUnattended = link.key == Self.expectedKey()
        if !allowUnattended {
            if Date().timeIntervalSince(self.lastPromptAt) < 1.0 {
                deepLinkLogger.debug("throttling deep link prompt")
                return
            }
            self.lastPromptAt = Date()

            let trimmed = messagePreview.count > 240 ? "\(messagePreview.prefix(240))…" : messagePreview
            let body =
                "Run the agent with this message?\n\n\(trimmed)\n\nURL:\n\(originalURL.absoluteString)"
            guard self.confirm(title: "Run Clawdis agent?", message: body) else { return }
        }

        if AppStateStore.shared.connectionMode == .local {
            GatewayProcessManager.shared.setActive(true)
        }

        do {
            var params: [String: AnyCodable] = [
                "message": AnyCodable(messagePreview),
                "idempotencyKey": AnyCodable(UUID().uuidString),
            ]
            if let sessionKey = link.sessionKey, !sessionKey.isEmpty { params["sessionKey"] = AnyCodable(sessionKey) }
            if let thinking = link.thinking, !thinking.isEmpty { params["thinking"] = AnyCodable(thinking) }
            if let to = link.to, !to.isEmpty { params["to"] = AnyCodable(to) }
            if let channel = link.channel, !channel.isEmpty { params["channel"] = AnyCodable(channel) }
            if let timeout = link.timeoutSeconds { params["timeout"] = AnyCodable(timeout) }
            params["deliver"] = AnyCodable(link.deliver)

            _ = try await GatewayConnection.shared.request(method: "agent", params: params)
        } catch {
            self.presentAlert(title: "Agent request failed", message: error.localizedDescription)
        }
    }

    // MARK: - Auth

    static func currentKey() -> String {
        self.expectedKey()
    }

    private static func expectedKey() -> String {
        let defaults = UserDefaults.standard
        if let key = defaults.string(forKey: deepLinkKeyKey), !key.isEmpty {
            return key
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let data = Data(bytes)
        let key = data
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        defaults.set(key, forKey: deepLinkKeyKey)
        return key
    }

    // MARK: - UI

    private func confirm(title: String, message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Run")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .informational
        alert.runModal()
    }
}
