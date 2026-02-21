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
    private var notifiedRunIds: [String] = []

    private let notificationManager = NotificationManager()

    private init() {}

    // MARK: - Lifecycle

    func start() {
        guard self.observeTask == nil else { return }
        self.observeTask = Task.detached { [weak self] in
            while !Task.isCancelled {
                // Ensure gateway is connected before subscribing (same as WebChat transport)
                do {
                    try await GatewayConnection.shared.refresh()
                } catch {
                    self?.logger.warning("reply notification observer: refresh failed, retrying in 2s")
                    try? await Task.sleep(for: .seconds(2))
                    continue
                }
                let stream = await GatewayConnection.shared.subscribe(bufferingNewest: 500)
                self?.logger.info("reply notification observer subscribed (post-refresh)")
                for await push in stream {
                    guard !Task.isCancelled else { break }
                    guard case let .event(evt) = push else { continue }
                    if evt.event == "chat" {
                        await self?.handleChatEvent(evt)
                    }
                }
                guard !Task.isCancelled else { break }
                self?.logger.info("reply notification observer: stream ended, resubscribing...")
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        self.logger.info("reply notification observer started")
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
        else {
            return
        }
        guard chat.state == "final" else {
            return
        }
        let runId = chat.runId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? chat.runId! : UUID().uuidString
        guard !self.notifiedRunIds.contains(runId) else { return }
        if self.panelVisible { return }
        guard AppStateStore.shared.replyNotificationsEnabled else { return }
        let body = self.extractPreview(from: chat.message?.foundationValue) ?? "Reply ready"
        self.notifiedRunIds.append(runId)
        if self.notifiedRunIds.count > 200 {
            self.notifiedRunIds = Array(self.notifiedRunIds.suffix(100))
        }
        self.sendReplyNotification(body: body)
    }

    private func sendReplyNotification(body: String) {
        let cleaned = Self.cleanPreviewForNotification(body)
        Task {
            let sent = await self.notificationManager.send(
                title: "OpenClaw",
                body: cleaned,
                sound: nil,
                priority: .active)
            if sent {
                self.logger.debug("reply notification sent")
            }
        }
    }

    /// Strips trailing/leading markdown (e.g. ** or *) so notification body doesn't show raw syntax.
    internal static func cleanPreviewForNotification(_ body: String) -> String {
        var s = body.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("**") || s.hasSuffix("*") || s.hasSuffix("__") || s.hasSuffix("_") {
            if s.hasSuffix("**") { s = String(s.dropLast(2)) }
            else if s.hasSuffix("__") { s = String(s.dropLast(2)) }
            else { s = String(s.dropLast(1)) }
        }
        while s.hasPrefix("**") || s.hasPrefix("*") || s.hasPrefix("__") || s.hasPrefix("_") {
            if s.hasPrefix("**") { s = String(s.dropFirst(2)) }
            else if s.hasPrefix("__") { s = String(s.dropFirst(2)) }
            else { s = String(s.dropFirst(1)) }
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
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
