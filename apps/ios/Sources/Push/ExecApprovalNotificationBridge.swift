import Foundation
import OpenClawKit
import OpenClawProtocol
@preconcurrency import UserNotifications

struct ApprovalNotificationPrompt: Codable, Equatable, Hashable {
    let approvalId: String
    let gatewayDeviceId: String?
    let kind: ApprovalKind

    init(
        approvalId: String,
        gatewayDeviceId: String?,
        kind: ApprovalKind = .exec)
    {
        self.approvalId = approvalId
        self.gatewayDeviceId = gatewayDeviceId
        self.kind = kind
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId
        case gatewayDeviceId
        case kind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.approvalId = try container.decode(String.self, forKey: .approvalId)
        self.gatewayDeviceId = try container.decodeIfPresent(String.self, forKey: .gatewayDeviceId)
        // Persisted exec recovery pushes predate the kind tag.
        self.kind = try container.decodeIfPresent(ApprovalKind.self, forKey: .kind) ?? .exec
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        let sameApprovalID = ExactOpaqueIdentifierKey(lhs.approvalId) ==
            ExactOpaqueIdentifierKey(rhs.approvalId)
        let sameGatewayID = lhs.gatewayDeviceId.map(ExactOpaqueIdentifierKey.init) ==
            rhs.gatewayDeviceId.map(ExactOpaqueIdentifierKey.init)
        return lhs.kind == rhs.kind && sameApprovalID && sameGatewayID
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.kind)
        hasher.combine(ExactOpaqueIdentifierKey(self.approvalId))
        hasher.combine(self.gatewayDeviceId.map(ExactOpaqueIdentifierKey.init))
    }
}

struct ApprovalNotificationConfiguration {
    let kind: ApprovalKind
    let requestedKind: String
    let resolvedKind: String
    let categoryIdentifier: String
    let reviewActionIdentifier: String
    let encodedRequestPrefix: String
    let legacyRequestPrefix: String
}

enum ApprovalNotificationBridge {
    static let exec = ApprovalNotificationConfiguration(
        kind: .exec,
        requestedKind: "exec.approval.requested",
        resolvedKind: "exec.approval.resolved",
        categoryIdentifier: "openclaw.exec-approval",
        reviewActionIdentifier: "openclaw.exec-approval.review",
        encodedRequestPrefix: "exec.approval-v2.",
        legacyRequestPrefix: "exec.approval.")
    static let plugin = ApprovalNotificationConfiguration(
        kind: .plugin,
        requestedKind: "plugin.approval.requested",
        resolvedKind: "plugin.approval.resolved",
        categoryIdentifier: "openclaw.plugin-approval",
        reviewActionIdentifier: "openclaw.plugin-approval.review",
        encodedRequestPrefix: "plugin.approval-v2.",
        legacyRequestPrefix: "plugin.approval.")
    private static let configurations = [ApprovalNotificationBridge.exec, ApprovalNotificationBridge.plugin]

    static func registerCategories(center: UNUserNotificationCenter = .current()) {
        let categories = self.configurations.map(self.category(for:))
        center.getNotificationCategories { existingCategories in
            var updated = existingCategories
            for category in categories {
                updated.update(with: category)
            }
            center.setNotificationCategories(updated)
        }
    }

    static func parsePrompt(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt?
    {
        for configuration in self.configurations where
            actionIdentifier == UNNotificationDefaultActionIdentifier ||
            actionIdentifier == configuration.reviewActionIdentifier
        {
            if let prompt = self.parsePush(
                userInfo: userInfo,
                expectedKind: configuration.requestedKind,
                configuration: configuration)
            {
                return prompt
            }
        }
        return nil
    }

    static func parseRequestedPush(
        userInfo: [AnyHashable: Any],
        kind: ApprovalKind? = nil) -> ApprovalNotificationPrompt?
    {
        for configuration in self.configurations where kind == nil || configuration.kind == kind {
            if let prompt = self.parsePush(
                userInfo: userInfo,
                expectedKind: configuration.requestedKind,
                configuration: configuration)
            {
                return prompt
            }
        }
        return nil
    }

    static func parseResolvedPush(userInfo: [AnyHashable: Any]) -> ApprovalNotificationPrompt? {
        for configuration in self.configurations {
            if let prompt = self.parsePush(
                userInfo: userInfo,
                expectedKind: configuration.resolvedKind,
                configuration: configuration)
            {
                return prompt
            }
        }
        return nil
    }

    @MainActor
    static func removeNotifications(
        for push: ApprovalNotificationPrompt,
        notificationCenter: NotificationCentering,
        includingLegacyOwnerless: Bool = false) async
    {
        guard let configuration = self.configurations.first(where: { $0.kind == push.kind }),
              let requestIdentifier = localRequestIdentifier(for: push, configuration: configuration)
        else { return }
        let legacyOwner = push.gatewayDeviceId ?? "legacy"
        var pendingIdentifiers = [
            requestIdentifier,
            "\(configuration.legacyRequestPrefix)\(legacyOwner).\(push.approvalId)",
        ]
        if includingLegacyOwnerless {
            pendingIdentifiers.append("\(configuration.legacyRequestPrefix)\(push.approvalId)")
            if let ownerlessIdentifier = localRequestIdentifier(
                for: ApprovalNotificationPrompt(
                    approvalId: push.approvalId,
                    gatewayDeviceId: nil,
                    kind: push.kind),
                configuration: configuration)
            {
                pendingIdentifiers.append(ownerlessIdentifier)
            }
        }
        var seenPendingIdentifiers = Set<String>()
        pendingIdentifiers = pendingIdentifiers.filter { seenPendingIdentifiers.insert($0).inserted }
        await notificationCenter.removePendingNotificationRequests(
            withIdentifiers: pendingIdentifiers)

        let delivered = await notificationCenter.deliveredNotifications()
        let identifiers = delivered.compactMap { snapshot -> String? in
            guard let requestedPush = self.parseRequestedPush(
                userInfo: snapshot.userInfo,
                kind: push.kind)
            else { return nil }
            let matchesCurrentOwner = requestedPush == push
            let matchesLegacyOwnerless = includingLegacyOwnerless &&
                ExactOpaqueIdentifierKey(requestedPush.approvalId) ==
                ExactOpaqueIdentifierKey(push.approvalId) &&
                requestedPush.gatewayDeviceId == nil
            guard matchesCurrentOwner || matchesLegacyOwnerless else { return nil }
            return snapshot.identifier
        }
        await notificationCenter.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private static func category(
        for configuration: ApprovalNotificationConfiguration) -> UNNotificationCategory
    {
        UNNotificationCategory(
            identifier: configuration.categoryIdentifier,
            actions: [
                UNNotificationAction(
                    identifier: configuration.reviewActionIdentifier,
                    title: "Review",
                    options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: [])
    }

    private static func parsePush(
        userInfo: [AnyHashable: Any],
        expectedKind: String,
        configuration: ApprovalNotificationConfiguration) -> ApprovalNotificationPrompt?
    {
        guard let payload = openClawPayload(userInfo: userInfo),
              (payload["kind"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) == expectedKind,
              let approvalId = ExecApprovalIdentifier.exact(payload["approvalId"] as? String)
        else {
            return nil
        }
        let gatewayDeviceId: String?
        if let rawGatewayDeviceId = payload["gatewayDeviceId"] {
            guard let rawGatewayDeviceId = rawGatewayDeviceId as? String,
                  let exactGatewayDeviceId = GatewayStableIdentifier.exact(rawGatewayDeviceId)
            else { return nil }
            gatewayDeviceId = exactGatewayDeviceId
        } else {
            gatewayDeviceId = nil
        }
        return ApprovalNotificationPrompt(
            approvalId: approvalId,
            gatewayDeviceId: gatewayDeviceId,
            kind: configuration.kind)
    }

    private static func localRequestIdentifier(
        for push: ApprovalNotificationPrompt,
        configuration: ApprovalNotificationConfiguration) -> String?
    {
        let owner = push.gatewayDeviceId ?? "legacy"
        guard let approvalID = ExecApprovalIdentifier.exact(push.approvalId) else {
            return nil
        }
        // The owner length disambiguates dots in this shipped notification ID format.
        let approvalComponent = ExactOpaqueIdentifierKey(approvalID).notificationComponent(preservingDots: true)
        let ownerComponent = ExactOpaqueIdentifierKey(owner).notificationComponent(preservingDots: true)
        return "\(configuration.encodedRequestPrefix)\(ownerComponent.utf8.count):" +
            "\(ownerComponent).\(approvalComponent)"
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
