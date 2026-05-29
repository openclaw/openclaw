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

    func requestAuthorization(options _: UNAuthorizationOptions) async throws -> Bool {
        true
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
    @Test func parsePromptMapsDefaultNotificationTap() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: UNNotificationDefaultActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-123",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(approvalId: "approval-123"))
    }

    @Test func parsePromptMapsReviewAction() {
        let prompt = ExecApprovalNotificationBridge.parsePrompt(
            actionIdentifier: ExecApprovalNotificationBridge.reviewActionIdentifier,
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-456",
                ],
            ])

        #expect(prompt == ExecApprovalNotificationPrompt(approvalId: "approval-456"))
    }

    @Test func parsePromptIgnoresUnexpectedActionIdentifiers() {
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

    @Test @MainActor func handleResolvedPushRemovesMatchingNotifications() async {
        let center = MockNotificationCenter()
        center.delivered = [
            NotificationSnapshot(
                identifier: "remote-approval-1",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-123",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "remote-other",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "approval-999",
                    ],
                ]),
        ]

        let handled = await ExecApprovalNotificationBridge.handleResolvedPushIfNeeded(
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.resolvedKind,
                    "approvalId": "approval-123",
                ],
            ],
            notificationCenter: center)

        #expect(handled)
        #expect(center.pendingRemovedIdentifiers == [["exec.approval.approval-123"]])
        #expect(center.deliveredRemovedIdentifiers == [["remote-approval-1"]])
    }
}
