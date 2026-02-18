import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

/// Observes gateway chat events and fires native macOS notifications
/// when the agent finishes a reply while the menu bar panel is hidden.
@MainActor
final class ReplyNotificationObserver {
    static let shared = ReplyNotificationObserver()

    private let logger = Logger(subsystem: "ai.openclaw", category: "reply-notifications")
    private var observeTask: Task<Void, Never>?
    private var panelVisible = false

    private let notificationManager = NotificationManager()

    private init() {}

    // MARK: - Lifecycle

    func start() {
        guard self.observeTask == nil else { return }
        self.observeTask = Task.detached { [weak self] in
            while !Task.isCancelled {
                let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 500)
                for await push in stream {
                    guard !Task.isCancelled else { break }
                    guard case let .event(evt) = push, evt.event == "chat" else { continue }
                    await self?.handleChatEvent(evt)
                }
                guard !Task.isCancelled else { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        self.logger.debug("reply notification observer started")
    }

    func stop() {
        self.observeTask?.cancel()
        self.observeTask = nil
    }

    // MARK: - Panel visibility

    func setPanelVisible(_ visible: Bool) {
        self.panelVisible = visible
    }

    // MARK: - Event handling

    private func handleChatEvent(_ evt: EventFrame) {
        guard let payload = evt.payload else {
            return
        }
        guard let chat = try? JSONDecoder().decode(
            OpenClawChatEventPayload.self,
            from: JSONEncoder().encode(payload))
        else { return }
        guard chat.state == "final" else { return }

        if self.panelVisible {
            return
        }
        guard AppStateStore.shared.replyNotificationsEnabled else {
            return
        }

        let body = self.extractPreview(from: chat.message?.foundationValue) ?? "Reply ready"

        Task {
            let sent = await self.notificationManager.send(
                title: "OpenClaw",
                body: body,
                sound: nil,
                priority: .active)
            if sent {
                self.logger.debug("reply notification sent")
            }
        }
    }

    func extractPreview(from message: Any?) -> String? {
        guard let msgDict = message as? [String: Any],
              let content = msgDict["content"] as? [[String: Any]],
              let first = content.first,
              let text = first["text"] as? String
        else { return nil }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.count > 120 {
            return String(trimmed.prefix(117)) + "…"
        }
        return trimmed
    }
}
