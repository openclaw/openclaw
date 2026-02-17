import Foundation
import OpenClawKit
import os
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "ShareExtension")
    private var statusLabel: UILabel?
    private let draftTextView = UITextView()
    private let sendButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var didPrepareDraft = false
    private var isSending = false

    override func viewDidLoad() {
        super.viewDidLoad()
        self.preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: 420)
        self.setupUI()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !self.didPrepareDraft else { return }
        self.didPrepareDraft = true
        Task { await self.prepareDraft() }
    }

    private func setupUI() {
        self.view.backgroundColor = .systemBackground

        self.draftTextView.translatesAutoresizingMaskIntoConstraints = false
        self.draftTextView.font = .preferredFont(forTextStyle: .body)
        self.draftTextView.backgroundColor = UIColor.secondarySystemBackground
        self.draftTextView.layer.cornerRadius = 10
        self.draftTextView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)

        self.sendButton.translatesAutoresizingMaskIntoConstraints = false
        self.sendButton.setTitle("Send to OpenClaw", for: .normal)
        self.sendButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        self.sendButton.addTarget(self, action: #selector(self.handleSendTap), for: .touchUpInside)
        self.sendButton.isEnabled = false

        self.cancelButton.translatesAutoresizingMaskIntoConstraints = false
        self.cancelButton.setTitle("Cancel", for: .normal)
        self.cancelButton.addTarget(self, action: #selector(self.handleCancelTap), for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [self.cancelButton, self.sendButton])
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.axis = .horizontal
        buttons.alignment = .fill
        buttons.distribution = .fillEqually
        buttons.spacing = 12

        self.view.addSubview(self.draftTextView)
        self.view.addSubview(buttons)

        NSLayoutConstraint.activate([
            self.draftTextView.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor, constant: 14),
            self.draftTextView.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 14),
            self.draftTextView.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -14),
            self.draftTextView.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -12),

            buttons.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 14),
            buttons.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -14),
            buttons.bottomAnchor.constraint(equalTo: self.view.keyboardLayoutGuide.topAnchor, constant: -8),
            buttons.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func prepareDraft() async {
        let traceId = UUID().uuidString
        ShareGatewayRelaySettings.saveLastEvent("Share opened.")
        self.showStatus("Preparing share…")
        self.logger.info("share begin trace=\(traceId, privacy: .public)")
        let payload = await self.extractSharedContent()
        self.logger.info(
            "share payload trace=\(traceId, privacy: .public) titleChars=\(payload.title?.count ?? 0) textChars=\(payload.text?.count ?? 0) hasURL=\(payload.url != nil)"
        )
        let message = self.composeDraft(from: payload)
        await MainActor.run {
            self.draftTextView.text = message
            self.sendButton.isEnabled = true
            self.draftTextView.becomeFirstResponder()
        }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ShareGatewayRelaySettings.saveLastEvent("Share ready: waiting for message input.")
            self.showStatus("Add a message, then tap Send.")
        } else {
            ShareGatewayRelaySettings.saveLastEvent("Share ready: draft prepared.")
            self.showStatus("Edit text, then tap Send.")
        }
    }

    @objc
    private func handleSendTap() {
        guard !self.isSending else { return }
        Task { await self.sendCurrentDraft() }
    }

    @objc
    private func handleCancelTap() {
        self.extensionContext?.completeRequest(returningItems: nil)
    }

    private func sendCurrentDraft() async {
        let message = await MainActor.run { self.draftTextView.text ?? "" }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            ShareGatewayRelaySettings.saveLastEvent("Share blocked: message is empty.")
            self.showStatus("Message is empty.")
            return
        }

        await MainActor.run {
            self.isSending = true
            self.sendButton.isEnabled = false
            self.cancelButton.isEnabled = false
        }
        self.showStatus("Sending to OpenClaw gateway…")
        ShareGatewayRelaySettings.saveLastEvent("Sending to gateway…")
        do {
            try await self.sendMessageToGateway(trimmed)
            ShareGatewayRelaySettings.saveLastEvent("Sent to gateway (\(trimmed.count) chars).")
            self.showStatus("Sent to OpenClaw.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        } catch {
            self.logger.error("share send failed reason=\(error.localizedDescription, privacy: .public)")
            ShareGatewayRelaySettings.saveLastEvent("Send failed: \(error.localizedDescription)")
            self.showStatus("Send failed: \(error.localizedDescription)")
            await MainActor.run {
                self.isSending = false
                self.sendButton.isEnabled = true
                self.cancelButton.isEnabled = true
            }
        }
    }

    private func sendMessageToGateway(_ message: String) async throws {
        guard let config = ShareGatewayRelaySettings.loadConfig() else {
            throw NSError(
                domain: "OpenClawShare",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "OpenClaw is not connected to a gateway yet."])
        }
        guard let url = URL(string: config.gatewayURLString) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 11,
                userInfo: [NSLocalizedDescriptionKey: "Invalid saved gateway URL."])
        }

        let gateway = GatewayNodeSession()
        defer {
            Task { await gateway.disconnect() }
        }
        let makeOptions: (String) -> GatewayConnectOptions = { clientId in
            GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: clientId,
                clientMode: "node",
                clientDisplayName: "OpenClaw Share",
                includeDeviceIdentity: false)
        }

        do {
            try await gateway.connect(
                url: url,
                token: config.token,
                password: config.password,
                connectOptions: makeOptions("openclaw-ios"),
                sessionBox: nil,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .invalidRequest,
                            message: "share extension does not support node invoke"))
                })
        } catch {
            let text = error.localizedDescription.lowercased()
            let expectsLegacyClientId = text.contains("invalid connect params") && text.contains("/client/id")
            guard expectsLegacyClientId else { throw error }
            try await gateway.connect(
                url: url,
                token: config.token,
                password: config.password,
                connectOptions: makeOptions("moltbot-ios"),
                sessionBox: nil,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .invalidRequest,
                            message: "share extension does not support node invoke"))
                })
        }

        struct AgentRequestPayload: Codable {
            var message: String
            var sessionKey: String?
            var thinking: String
            var deliver: Bool
            var receipt: Bool
            var receiptText: String?
            var to: String?
            var channel: String?
            var timeoutSeconds: Int?
            var key: String?
        }

        let params = AgentRequestPayload(
            message: message,
            sessionKey: config.sessionKey,
            thinking: "low",
            deliver: true,
            receipt: true,
            receiptText: "Just received your iOS share + request, working on it.",
            to: config.deliveryTo,
            channel: config.deliveryChannel,
            timeoutSeconds: nil,
            key: UUID().uuidString)
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 12,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode chat payload."])
        }
        struct NodeEventParams: Codable {
            var event: String
            var payloadJSON: String
        }
        let eventData = try JSONEncoder().encode(NodeEventParams(event: "agent.request", payloadJSON: json))
        guard let nodeEventParams = String(data: eventData, encoding: .utf8) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 13,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode node event payload."])
        }
        _ = try await gateway.request(method: "node.event", paramsJSON: nodeEventParams, timeoutSeconds: 25)
    }

    private func showStatus(_ text: String) {
        DispatchQueue.main.async {
            let label: UILabel
            if let existing = self.statusLabel {
                label = existing
            } else {
                let newLabel = UILabel()
                newLabel.translatesAutoresizingMaskIntoConstraints = false
                newLabel.numberOfLines = 0
                newLabel.textAlignment = .center
                newLabel.font = .preferredFont(forTextStyle: .body)
                newLabel.textColor = .label
                newLabel.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
                newLabel.layer.cornerRadius = 12
                newLabel.clipsToBounds = true
                newLabel.layoutMargins = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
                self.view.addSubview(newLabel)
                NSLayoutConstraint.activate([
                    newLabel.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 18),
                    newLabel.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -18),
                    newLabel.bottomAnchor.constraint(equalTo: self.sendButton.topAnchor, constant: -10),
                ])
                self.statusLabel = newLabel
                label = newLabel
            }
            label.text = "  \(text)  "
        }
    }

    private func composeDraft(from payload: SharedContentPayload) -> String {
        var lines: [String] = []
        let title = self.sanitizeDraftFragment(payload.title)
        let text = self.sanitizeDraftFragment(payload.text)
        let url = payload.url?.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if let title, !title.isEmpty { lines.append(title) }
        if let text, !text.isEmpty { lines.append(text) }
        if !url.isEmpty { lines.append(url) }

        return lines.joined(separator: "\n\n")
    }

    private func sanitizeDraftFragment(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let banned = [
            "shared from ios.",
            "text:",
            "shared attachment(s):",
            "please help me with this.",
            "please help me with this.w",
        ]
        let cleanedLines = raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { line in
                guard !line.isEmpty else { return false }
                let lowered = line.lowercased()
                return !banned.contains { lowered == $0 || lowered.hasPrefix($0) }
            }
        let cleaned = cleanedLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private func extractSharedContent() async -> SharedContentPayload {
        guard let items = self.extensionContext?.inputItems as? [NSExtensionItem] else {
            return SharedContentPayload(title: nil, url: nil, text: nil)
        }

        var title: String?
        var sharedURL: URL?
        var sharedText: String?
        var imageCount = 0
        var videoCount = 0
        var fileCount = 0
        var unknownCount = 0

        for item in items {
            if title == nil {
                title = item.attributedTitle?.string ?? item.attributedContentText?.string
            }

            for provider in item.attachments ?? [] {
                if sharedURL == nil {
                    sharedURL = await self.loadURL(from: provider)
                }

                if sharedText == nil {
                    sharedText = await self.loadText(from: provider)
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    imageCount += 1
                } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    videoCount += 1
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    fileCount += 1
                } else {
                    unknownCount += 1
                }

                if sharedURL != nil, sharedText != nil {
                    break
                }
            }
        }

        _ = imageCount
        _ = videoCount
        _ = fileCount
        _ = unknownCount

        return SharedContentPayload(title: title, url: sharedURL, text: sharedText)
    }

    private func loadURL(from provider: NSItemProvider) async -> URL? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await self.loadURLValue(
                from: provider,
                typeIdentifier: UTType.url.identifier)
            {
                return url
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
            if let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier),
               let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
                   url.scheme != nil
            {
                return url
            }
        }

        return nil
    }

    private func loadText(from provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.plainText.identifier) {
                return text
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await self.loadURLValue(from: provider, typeIdentifier: UTType.url.identifier) {
                return url.absoluteString
            }
        }

        return nil
    }

    private func loadURLValue(from provider: NSItemProvider, typeIdentifier: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                    return
                }
                if let str = item as? String, let url = URL(string: str) {
                    continuation.resume(returning: url)
                    return
                }
                if let ns = item as? NSString, let url = URL(string: ns as String) {
                    continuation.resume(returning: url)
                    return
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private func loadTextValue(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let text = item as? String {
                    continuation.resume(returning: text)
                    return
                }
                if let text = item as? NSString {
                    continuation.resume(returning: text as String)
                    return
                }
                if let text = item as? NSAttributedString {
                    continuation.resume(returning: text.string)
                    return
                }
                continuation.resume(returning: nil)
            }
        }
    }
}
