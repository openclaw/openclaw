import ClawdisIPC
import Foundation
import UserNotifications

@MainActor
struct NotificationManager {
    func send(title: String, body: String, sound: String?, priority: NotificationPriority? = nil) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings()
        if status.authorizationStatus == .notDetermined {
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            if granted != true { return false }
        } else if status.authorizationStatus != .authorized {
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let soundName = sound, !soundName.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
        }

        // Set interruption level based on priority
        if let priority {
            switch priority {
            case .passive:
                content.interruptionLevel = .passive
            case .active:
                content.interruptionLevel = .active
            case .timeSensitive:
                content.interruptionLevel = .timeSensitive
            }
        }

        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await center.add(req)
            return true
        } catch {
            return false
        }
    }
}
