import Foundation
import OpenClawKit
import OpenClawProtocol
@preconcurrency import UserNotifications

private struct ApprovalNotificationUTF8Key: Hashable {
    let bytes: [UInt8]

    init(_ rawValue: String) {
        self.bytes = Array(rawValue.utf8)
    }

    var notificationComponent: String {
        let hexDigits = Array("0123456789ABCDEF".utf8)
        var encoded: [UInt8] = []
        encoded.reserveCapacity(self.bytes.count)
        for byte in self.bytes {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F, 0x7E:
                encoded.append(byte)
            default:
                encoded.append(0x25)
                encoded.append(hexDigits[Int(byte >> 4)])
                encoded.append(hexDigits[Int(byte & 0x0F)])
            }
        }
        guard let component = String(bytes: encoded, encoding: .utf8) else {
            preconditionFailure("Percent-encoded approval ID must be UTF-8")
        }
        return component
    }
}

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
        let sameApprovalID = ApprovalNotificationUTF8Key(lhs.approvalId) ==
            ApprovalNotificationUTF8Key(rhs.approvalId)
        let sameGatewayID = lhs.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init) ==
            rhs.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init)
        return lhs.kind == rhs.kind && sameApprovalID && sameGatewayID
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.kind)
        hasher.combine(ApprovalNotificationUTF8Key(self.approvalId))
        hasher.combine(self.gatewayDeviceId.map(ApprovalNotificationUTF8Key.init))
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
                ApprovalNotificationUTF8Key(requestedPush.approvalId) ==
                ApprovalNotificationUTF8Key(push.approvalId) &&
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
        let approvalComponent = ApprovalNotificationUTF8Key(approvalID).notificationComponent
        let ownerComponent = ApprovalNotificationUTF8Key(owner).notificationComponent
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
