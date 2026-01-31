import OpenClawKit
import Foundation
import Testing
import UserNotifications
@testable import OpenClaw

actor TestNotificationCenter: NotificationCentering {
    private var status: NotificationAuthorizationStatus
    private let requestResult: Bool
    private var requestedAuthorization: Bool = false
    private var storedRequests: [UNNotificationRequest] = []

    init(status: NotificationAuthorizationStatus, requestResult: Bool) {
        self.status = status
        self.requestResult = requestResult
    }

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        status
    }

    func requestAuthorization(options _: UNAuthorizationOptions) async throws -> Bool {
        self.requestedAuthorization = true
        if self.requestResult {
            self.status = .authorized
        }
        return self.requestResult
    }

    func add(_ request: UNNotificationRequest) async throws {
        self.storedRequests.append(request)
    }

    func didRequestAuthorization() async -> Bool {
        requestedAuthorization
    }

    func requests() async -> [UNNotificationRequest] {
        storedRequests
    }
}

@Suite(.serialized) struct NodeAppModelNotifyTests {
    @Test @MainActor func handleSystemNotifyRequestsPermissionAndAddsNotification() async throws {
        let center = TestNotificationCenter(status: .notDetermined, requestResult: true)
        let appModel = NodeAppModel(notificationCenter: center)

        let params = OpenClawSystemNotifyParams(title: "Hello", body: "World")
        let data = try JSONEncoder().encode(params)
        let json = String(decoding: data, as: UTF8.self)

        let req = BridgeInvokeRequest(
            id: "notify",
            command: OpenClawSystemCommand.notify.rawValue,
            paramsJSON: json)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(await center.didRequestAuthorization() == true)

        let requests = await center.requests()
        #expect(requests.count == 1)
        #expect(requests.first?.content.title == "Hello")
        #expect(requests.first?.content.body == "World")
    }
}
