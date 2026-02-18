import Foundation
import Observation
import UserNotifications
import WatchKit

struct WatchNotifyMessage: Sendable {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int?
}

@MainActor @Observable final class WatchInboxStore {
    private struct PersistedState: Codable {
        var title: String
        var body: String
        var transport: String
        var updatedAt: Date
        var lastDeliveryKey: String?
    }

    private static let persistedStateKey = "watch.inbox.state.v1"
    private let defaults: UserDefaults

    var title = "OpenClaw"
    var body = "Waiting for messages from your iPhone."
    var transport = "none"
    var updatedAt: Date?
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
        self.lastDeliveryKey = deliveryKey
        self.persistState()

        Task {
            await self.postLocalNotification(
                identifier: deliveryKey,
                title: normalizedTitle,
                body: message.body)
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
    }

    private func persistState() {
        guard let updatedAt = self.updatedAt else { return }
        let state = PersistedState(
            title: self.title,
            body: self.body,
            transport: self.transport,
            updatedAt: updatedAt,
            lastDeliveryKey: self.lastDeliveryKey)
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

    private func postLocalNotification(identifier: String, title: String, body: String) async {
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
        WKInterfaceDevice.current().play(.notification)
    }
}
