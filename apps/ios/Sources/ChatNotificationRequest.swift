import Foundation

/// APNs supplies a hint, never permission to display a conversation.
struct ChatNotificationRequest: Equatable, Sendable {
    let notificationID: String
    let gatewayDeviceId: String
    let sessionKey: String

    @MainActor
    func resolve(
        gatewayIdentity: () async throws -> String,
        session: (String) async throws -> String?,
        isCurrent: () -> Bool) async rethrows -> String?
    {
        guard isCurrent() else { return nil }
        let gatewayID = try await gatewayIdentity()
        guard isCurrent(), GatewayStableIdentifier.matches(gatewayID, self.gatewayDeviceId) else { return nil }
        let resolved = try await session(self.sessionKey)
        guard isCurrent(), let resolved, resolved.utf8.elementsEqual(self.sessionKey.utf8) else { return nil }
        return resolved
    }

    static func parse(notificationID: String, userInfo: [AnyHashable: Any]) -> Self? {
        guard let payload = userInfo["openclaw"] as? [String: Any],
              payload["kind"] as? String == "push.test",
              let destination = payload["destination"] as? [String: Any],
              let gatewayDeviceId = destination["gatewayDeviceId"] as? String,
              let sessionKey = destination["sessionKey"] as? String,
              !notificationID.isEmpty,
              !gatewayDeviceId.isEmpty,
              !sessionKey.isEmpty,
              gatewayDeviceId == gatewayDeviceId.trimmingCharacters(in: .whitespacesAndNewlines),
              sessionKey == sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        return Self(notificationID: notificationID, gatewayDeviceId: gatewayDeviceId, sessionKey: sessionKey)
    }
}
