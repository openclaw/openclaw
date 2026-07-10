import Foundation
@preconcurrency import UserNotifications

struct ExecApprovalNotificationPrompt: Codable, Equatable, Hashable {
    let approvalId: String
    let gatewayDeviceId: String?
}

enum ExecApprovalNotificationBridge {
    static let requestedKind = "exec.approval.requested"
    static let resolvedKind = "exec.approval.resolved"
    static let categoryIdentifier = "openclaw.exec-approval"
    static let reviewActionIdentifier = "openclaw.exec-approval.review"

    private static let localRequestPrefix = "exec.approval."

    static func registerCategory(center: UNUserNotificationCenter = .current()) {
        let category = UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(
                    identifier: reviewActionIdentifier,
                    title: "Review",
                    options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: [])

        center.getNotificationCategories { categories in
            var updated = categories
            updated.update(with: category)
            center.setNotificationCategories(updated)
        }
    }

    static func shouldPresentNotification(userInfo: [AnyHashable: Any]) -> Bool {
        self.parsePush(userInfo: userInfo, expectedKind: self.requestedKind) != nil
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt?
    {
        guard actionIdentifier == UNNotificationDefaultActionIdentifier
            || actionIdentifier == self.reviewActionIdentifier
        else {
            return nil
        }
        return self.parseRequestedPush(userInfo: userInfo)
    }

    static func parseRequestedPush(userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt? {
        self.parsePush(userInfo: userInfo, expectedKind: self.requestedKind)
    }

    static func parseResolvedPush(userInfo: [AnyHashable: Any]) -> ExecApprovalNotificationPrompt? {
        self.parsePush(userInfo: userInfo, expectedKind: self.resolvedKind)
    }

    @MainActor
    static func removeNotifications(
        for push: ExecApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        var pendingIdentifiers = [self.localRequestIdentifier(for: push)]
        if includingLegacyOwnerless {
            pendingIdentifiers.append("\(self.localRequestPrefix)\(push.approvalId)")
            pendingIdentifiers.append(self.localRequestIdentifier(for: ExecApprovalNotificationPrompt(
                approvalId: push.approvalId,
                gatewayDeviceId: nil)))
        }
        var seenPendingIdentifiers = Set<String>()
        pendingIdentifiers = pendingIdentifiers.filter { seenPendingIdentifiers.insert($0).inserted }
        await notificationCenter.removePendingNotificationRequests(
            withIdentifiers: pendingIdentifiers)

        let delivered = await notificationCenter.deliveredNotifications()
        let identifiers = delivered.compactMap { snapshot -> String? in
            guard let requestedPush = self.parseRequestedPush(userInfo: snapshot.userInfo) else { return nil }
            let matchesCurrentOwner = requestedPush == push
            let matchesLegacyOwnerless = includingLegacyOwnerless &&
                requestedPush.approvalId == push.approvalId &&
                requestedPush.gatewayDeviceId == nil
            guard matchesCurrentOwner || matchesLegacyOwnerless else { return nil }
            return snapshot.identifier
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    static func approvalID(from userInfo: [AnyHashable: Any]) -> String? {
        let raw = self.openClawPayload(userInfo: userInfo)?["approvalId"] as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func gatewayDeviceID(from userInfo: [AnyHashable: Any]) -> String? {
        let raw = self.openClawPayload(userInfo: userInfo)?["gatewayDeviceId"] as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func parsePush(
        userInfo: [AnyHashable: Any],
        expectedKind: String) -> ExecApprovalNotificationPrompt?
    {
        guard self.payloadKind(userInfo: userInfo) == expectedKind,
              let approvalId = approvalID(from: userInfo)
        else {
            return nil
        }
        return ExecApprovalNotificationPrompt(
            approvalId: approvalId,
            gatewayDeviceId: self.gatewayDeviceID(from: userInfo))
    }

    private static func localRequestIdentifier(for push: ExecApprovalNotificationPrompt) -> String {
        let owner = push.gatewayDeviceId ?? "legacy"
        return "\(self.localRequestPrefix)\(owner).\(push.approvalId)"
    }

    static func payloadKind(userInfo: [AnyHashable: Any]) -> String {
        let raw = self.openClawPayload(userInfo: userInfo)?["kind"] as? String
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private static func openClawPayload(userInfo: [AnyHashable: Any]) -> [String: Any]? {
        if let payload = userInfo["openclaw"] as? [String: Any] {
            return payload
        }
        if let payload = userInfo["openclaw"] as? [AnyHashable: Any] {
            return payload.reduce(into: [String: Any]()) { partialResult, pair in
                guard let key = pair.key as? String else { return }
                partialResult[key] = pair.value
            }
        }
        return nil
    }
}
