import Foundation
import UserNotifications

enum NotificationAuthorizationStatus: Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral
}

protocol NotificationCentering: Sendable {
    func authorizationStatus() async -> NotificationAuthorizationStatus
    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool
    func add(_ request: UNNotificationRequest) async throws
}

struct LiveNotificationCenter: NotificationCentering, @unchecked Sendable {
    private let center: UNUserNotificationCenter

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
    }

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        let settings = await self.center.notificationSettings()
        return switch settings.authorizationStatus {
        case .authorized:
            .authorized
        case .provisional:
            .provisional
        case .ephemeral:
            .ephemeral
        case .denied:
            .denied
        case .notDetermined:
            .notDetermined
        @unknown default:
            .denied
        }
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await self.center.requestAuthorization(options: options)
    }

    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.center.add(request) { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume(returning: ())
                }
            }
        }
    }
}
