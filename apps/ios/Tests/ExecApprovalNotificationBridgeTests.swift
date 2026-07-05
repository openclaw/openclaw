import Foundation
import Testing
import UserNotifications
@testable import OpenClaw

private final class MockNotificationCenter: NotificationCentering, @unchecked Sendable {
    var authorization: NotificationAuthorizationStatus = .authorized
    var addedRequests: [UNNotificationRequest] = []
    var pendingRemovedIdentifiers: [[String]] = []
    var deliveredRemovedIdentifiers: [[String]] = []
    var delivered: [NotificationSnapshot] = []

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        self.authorization
    }

    func add(_ request: UNNotificationRequest) async throws {
        self.addedRequests.append(request)
    }

    func removePendingNotificationRequests(withIdentifiers identifiers: [String]) async {
        self.pendingRemovedIdentifiers.append(identifiers)
    }

    func removeDeliveredNotifications(withIdentifiers identifiers: [String]) async {
        self.deliveredRemovedIdentifiers.append(identifiers)
    }

    func deliveredNotifications() async -> [NotificationSnapshot] {
        self.delivered
    }
}

@Suite(.serialized) struct ExecApprovalNotificationBridgeTests {
    @Test func `parse prompt maps default notification tap`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-123",
                    "gatewayDeviceId": "gateway-a",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(
            approvalId: "approval-123",
            gatewayDeviceId: "gateway-a"))
    }

    @Test func `parse prompt maps review action`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: ExecApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-456",
                    "gatewayDeviceId": "gateway-b",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(
            approvalId: "approval-456",
            gatewayDeviceId: "gateway-b"))
    }

    @Test func `parse prompt ignores unexpected action identifiers`() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: "openclaw.exec-approval.allow-once",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-789",
                ],
            ])

        #expect(prompt == nil)
    }

    @Test @MainActor func `handle resolved push removes matching notifications`() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "remote-approval-1",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-123",
                        "gatewayDeviceId": "gateway-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "remote-other",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-123",
                        "gatewayDeviceId": "gateway-b",
                    ],
                ]),
        ]

        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-123",
            gatewayDeviceId: "gateway-a")
        await ExecApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: center)

        #expect(center.pendingRemovedIdentifiers == [["exec.approval.gateway-a.approval-123"]])
        #expect(center.deliveredRemovedIdentifiers == [["remote-approval-1"]])
    }

    @Test func `legacy ownerless approval pushes remain parseable for authenticated route validation`() {
        let userInfo: [AnyHashable: Any] = [
            "openclaw": [
                "kind": ExecApprovalNotificationBridge.requestedKind,
                "approvalId": "approval-ownerless",
            ],
        ]

        #expect(ExecApprovalNotificationBridge.parseRequestedPush(userInfo: userInfo) ==
            ExecApprovalNotificationPrompt(
                approvalId: "approval-ownerless",
                gatewayDeviceId: nil))
        #expect(ExecApprovalNotificationBridge.shouldPresentNotification(userInfo: userInfo))
    }

    @Test @MainActor func `validated cleanup removes legacy ownerless alerts but preserves other owners`() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "legacy-ownerless",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-shared",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "other-owner",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-shared",
                        "gatewayDeviceId": "gateway-b",
                    ],
                ]),
        ]
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-shared",
            gatewayDeviceId: "gateway-a")

        await ExecApprovalNotificationBridge.removeNotifications(
            for: push,
            notificationCenter: center,
            includingLegacyOwnerless: true)

        #expect(center.pendingRemovedIdentifiers == [[
            "exec.approval.gateway-a.approval-shared",
            "exec.approval.approval-shared",
            "exec.approval.legacy.approval-shared",
        ]])
        #expect(center.deliveredRemovedIdentifiers == [["legacy-ownerless"]])
    }
}
