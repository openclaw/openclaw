import Foundation
import Observation
import UserNotifications
import WatchKit

struct WatchPromptAction: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var label: String
    var style: String?
}

struct WatchNotifyMessage: Sendable {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int?
    var promptId: String?
    var sessionKey: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int?
    var risk: String?
    var actions: [WatchPromptAction]
}

@MainActor @Observable final class WatchInboxStore {
    private struct PersistedState: Codable {
        var title: String
        var body: String
        var transport: String
        var updatedAt: Date
        var lastDeliveryKey: String?
        var promptId: String?
        var sessionKey: String?
        var kind: String?
        var details: String?
        var expiresAtMs: Int?
        var risk: String?
        var actions: [WatchPromptAction]?
        var replyStatusText: String?
        var replyStatusAt: Date?
    }

    private static let persistedStateKey = "watch.inbox.state.v1"
    private let defaults: UserDefaults

    var title = "OpenClaw"
    var body = "Waiting for messages from your iPhone."
    var transport = "none"
    var updatedAt: Date?
    var promptId: String?
    var sessionKey: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int?
    var risk: String?
    var actions: [WatchPromptAction] = []
    var replyStatusText: String?
    var replyStatusAt: Date?
    var isReplySending = false
    private var lastDeliveryKey: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.restorePersistedState()
        Task {
            await self.ensureNotificationAuthorization()
        }
    }

    func consume(message: WatchNotifyMessage, transport: String) {
        let messageID = message.id?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let deliveryKey = self.deliveryKey(
            messageID: messageID,
            title: message.title,
            body: message.body,
            sentAtMs: message.sentAtMs)
        guard deliveryKey != self.lastDeliveryKey else { return }

        let normalizedTitle = message.title.isEmpty ? "OpenClaw" : message.title
        self.title = normalizedTitle
        self.body = message.body
        self.transport = transport
        self.updatedAt = Date()
        self.promptId = message.promptId
        self.sessionKey = message.sessionKey
        self.kind = message.kind
        self.details = message.details
        self.expiresAtMs = message.expiresAtMs
        self.risk = message.risk
        self.actions = message.actions
        self.lastDeliveryKey = deliveryKey
        self.replyStatusText = nil
        self.replyStatusAt = nil
        self.isReplySending = false
        self.persistState()

        Task {
            await self.postLocalNotification(
                identifier: deliveryKey,
                title: normalizedTitle,
                body: message.body,
                risk: message.risk)
        }
    }

    private func restorePersistedState() {
        guard let data = self.defaults.data(forKey: Self.persistedStateKey),
            let state = try? JSONDecoder().decode(PersistedState.self, from: data)
        else {
            return
        }

        self.title = state.title
        self.body = state.body
        self.transport = state.transport
        self.updatedAt = state.updatedAt
        self.lastDeliveryKey = state.lastDeliveryKey
        self.promptId = state.promptId
        self.sessionKey = state.sessionKey
        self.kind = state.kind
        self.details = state.details
        self.expiresAtMs = state.expiresAtMs
        self.risk = state.risk
        self.actions = state.actions ?? []
        self.replyStatusText = state.replyStatusText
        self.replyStatusAt = state.replyStatusAt
    }

    private func persistState() {
        guard let updatedAt = self.updatedAt else { return }
        let state = PersistedState(
            title: self.title,
            body: self.body,
            transport: self.transport,
            updatedAt: updatedAt,
            lastDeliveryKey: self.lastDeliveryKey,
            promptId: self.promptId,
            sessionKey: self.sessionKey,
            kind: self.kind,
            details: self.details,
            expiresAtMs: self.expiresAtMs,
            risk: self.risk,
            actions: self.actions,
            replyStatusText: self.replyStatusText,
            replyStatusAt: self.replyStatusAt)
        guard let data = try? JSONEncoder().encode(state) else { return }
        self.defaults.set(data, forKey: Self.persistedStateKey)
    }

    private func deliveryKey(messageID: String?, title: String, body: String, sentAtMs: Int?) -> String {
        if let messageID, messageID.isEmpty == false {
            return "id:\(messageID)"
        }
        return "content:\(title)|\(body)|\(sentAtMs ?? 0)"
    }

    private func ensureNotificationAuthorization() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        default:
            break
        }
    }

    private func mapHapticRisk(_ risk: String?) -> WKHapticType {
        switch risk?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "high":
            return .failure
        case "medium":
            return .notification
        default:
            return .click
        }
    }

    func makeReplyDraft(action: WatchPromptAction) -> WatchReplyDraft {
        let prompt = self.promptId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchReplyDraft(
            replyId: UUID().uuidString,
            promptId: (prompt?.isEmpty == false) ? prompt! : "unknown",
            actionId: action.id,
            actionLabel: action.label,
            sessionKey: self.sessionKey,
            note: nil,
            sentAtMs: Int(Date().timeIntervalSince1970 * 1000))
    }

    func markReplySending(actionLabel: String) {
        self.isReplySending = true
        self.replyStatusText = "Sending \(actionLabel)…"
        self.replyStatusAt = Date()
        self.persistState()
    }

    func markReplyResult(_ result: WatchReplySendResult, actionLabel: String) {
        self.isReplySending = false
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.replyStatusText = "Failed: \(errorMessage)"
        } else if result.deliveredImmediately {
            self.replyStatusText = "\(actionLabel): sent"
        } else if result.queuedForDelivery {
            self.replyStatusText = "\(actionLabel): queued"
        } else {
            self.replyStatusText = "\(actionLabel): sent"
        }
        self.replyStatusAt = Date()
        self.persistState()
    }

    private func postLocalNotification(identifier: String, title: String, body: String, risk: String?) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "openclaw-watch"

        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.2, repeats: false))

        _ = try? await UNUserNotificationCenter.current().add(request)
        WKInterfaceDevice.current().play(self.mapHapticRisk(risk))
    }
}
