import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
import UIKit
import UserNotifications
@testable import OpenClaw

private func makeAgentDeepLinkURL(
    message: String,
    deliver: Bool = false,
    to: String? = nil,
    channel: String? = nil,
    key: String? = nil) -> URL
{
    var components = URLComponents()
    components.scheme = "openclaw"
    components.host = "agent"
    var queryItems: [URLQueryItem] = [URLQueryItem(name: "message", value: message)]
    if deliver {
        queryItems.append(URLQueryItem(name: "deliver", value: "1"))
    }
    if let to {
        queryItems.append(URLQueryItem(name: "to", value: to))
    }
    if let channel {
        queryItems.append(URLQueryItem(name: "channel", value: channel))
    }
    if let key {
        queryItems.append(URLQueryItem(name: "key", value: key))
    }
    components.queryItems = queryItems
    return components.url!
}

private func makeWatchChatRawMessage(
    role: String,
    text: String?,
    type: String = "text",
    timestamp: Double) throws -> AnyCodable
{
    let message = OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: type,
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp)
    let data = try JSONEncoder().encode(message)
    return try JSONDecoder().decode(AnyCodable.self, from: data)
}

@MainActor
private func mountScreen(_ screen: ScreenController) throws -> ScreenWebViewCoordinator {
    let coordinator = ScreenWebViewCoordinator(controller: screen)
    _ = coordinator.makeContainerView()
    _ = try #require(coordinator.managedWebView)
    return coordinator
}

@MainActor
private final class MockWatchMessagingService: @preconcurrency WatchMessagingServicing, @unchecked Sendable {
    var currentStatus = WatchMessagingStatus(
        supported: true,
        paired: true,
        appInstalled: true,
        reachable: true,
        activationState: "activated")
    var nextSendResult = WatchNotificationSendResult(
        deliveredImmediately: true,
        queuedForDelivery: false,
        transport: "sendMessage")
    var sendError: Error?
    var lastSent: (id: String, params: OpenClawWatchNotifyParams)?
    var lastSentExecApprovalPrompt: OpenClawWatchExecApprovalPromptMessage?
    var lastSentExecApprovalResolved: OpenClawWatchExecApprovalResolvedMessage?
    var lastSentExecApprovalExpired: OpenClawWatchExecApprovalExpiredMessage?
    var lastSentExecApprovalSnapshot: OpenClawWatchExecApprovalSnapshotMessage?
    var sentExecApprovalSnapshots: [OpenClawWatchExecApprovalSnapshotMessage] = []
    var lastSentAppSnapshot: OpenClawWatchAppSnapshotMessage?
    var syncExecApprovalSnapshotHandler: ((OpenClawWatchExecApprovalSnapshotMessage) async throws
        -> WatchNotificationSendResult)?
    private var statusHandler: (@Sendable (WatchMessagingStatus) -> Void)?
    private var replyHandler: (@Sendable (WatchQuickReplyEvent) -> Void)?
    private var execApprovalResolveHandler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?
    private var execApprovalSnapshotRequestHandler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?
    private var appSnapshotRequestHandler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?
    private var appCommandHandler: (@Sendable (WatchAppCommandEvent) -> Void)?

    func status() async -> WatchMessagingStatus {
        self.currentStatus
    }

    func setStatusHandler(_ handler: (@Sendable (WatchMessagingStatus) -> Void)?) {
        self.statusHandler = handler
    }

    func setReplyHandler(_ handler: (@Sendable (WatchQuickReplyEvent) -> Void)?) {
        self.replyHandler = handler
    }

    func setExecApprovalResolveHandler(_ handler: (@Sendable (WatchExecApprovalResolveEvent) -> Void)?) {
        self.execApprovalResolveHandler = handler
    }

    func setExecApprovalSnapshotRequestHandler(
        _ handler: (@Sendable (WatchExecApprovalSnapshotRequestEvent) -> Void)?)
    {
        self.execApprovalSnapshotRequestHandler = handler
    }

    func setAppSnapshotRequestHandler(_ handler: (@Sendable (WatchAppSnapshotRequestEvent) -> Void)?) {
        self.appSnapshotRequestHandler = handler
    }

    func setAppCommandHandler(_ handler: (@Sendable (WatchAppCommandEvent) -> Void)?) {
        self.appCommandHandler = handler
    }

    func sendNotification(id: String, params: OpenClawWatchNotifyParams) async throws -> WatchNotificationSendResult {
        self.lastSent = (id: id, params: params)
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalPrompt(
        _ message: OpenClawWatchExecApprovalPromptMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalPrompt = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalResolved(
        _ message: OpenClawWatchExecApprovalResolvedMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalResolved = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func sendExecApprovalExpired(
        _ message: OpenClawWatchExecApprovalExpiredMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalExpired = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func syncExecApprovalSnapshot(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentExecApprovalSnapshot = message
        self.sentExecApprovalSnapshots.append(message)
        if let syncExecApprovalSnapshotHandler {
            return try await syncExecApprovalSnapshotHandler(message)
        }
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func syncAppSnapshot(
        _ message: OpenClawWatchAppSnapshotMessage) async throws -> WatchNotificationSendResult
    {
        self.lastSentAppSnapshot = message
        if let sendError {
            throw sendError
        }
        return self.nextSendResult
    }

    func emitReply(_ event: WatchQuickReplyEvent) {
        self.replyHandler?(event)
    }

    func emitExecApprovalResolve(_ event: WatchExecApprovalResolveEvent) {
        self.execApprovalResolveHandler?(event)
    }

    func emitExecApprovalSnapshotRequest(_ event: WatchExecApprovalSnapshotRequestEvent) {
        self.execApprovalSnapshotRequestHandler?(event)
    }

    func emitAppSnapshotRequest(_ event: WatchAppSnapshotRequestEvent) {
        self.appSnapshotRequestHandler?(event)
    }

    func emitAppCommand(_ event: WatchAppCommandEvent) {
        self.appCommandHandler?(event)
    }
}

private final class MockBootstrapNotificationCenter: NotificationCentering, @unchecked Sendable {
    var status: NotificationAuthorizationStatus = .notDetermined
    var authorizationStatusHandler: (@Sendable () async -> NotificationAuthorizationStatus)?
    var addCalls = 0
    var pendingRemovedIdentifiers: [[String]] = []
    var deliveredRemovedIdentifiers: [[String]] = []
    var delivered: [NotificationSnapshot] = []

    func authorizationStatus() async -> NotificationAuthorizationStatus {
        if let authorizationStatusHandler {
            return await authorizationStatusHandler()
        }
        return self.status
    }

    func add(_: UNNotificationRequest) async throws {
        self.addCalls += 1
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

private actor NotificationAuthorizationGate {
    private var didStart = false
    private var continuation: CheckedContinuation<NotificationAuthorizationStatus, Never>?

    func wait() async -> NotificationAuthorizationStatus {
        self.didStart = true
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func hasStarted() -> Bool {
        self.didStart
    }

    func resume(returning status: NotificationAuthorizationStatus) {
        self.continuation?.resume(returning: status)
        self.continuation = nil
    }
}

private actor WatchSnapshotSendGate {
    private var didStart = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        self.didStart = true
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func hasStarted() -> Bool {
        self.didStart
    }

    func resume() {
        self.continuation?.resume()
        self.continuation = nil
    }
}

@Suite(.serialized) struct NodeAppModelInvokeTests {
    @Test @MainActor func `decode params fails without JSON`() {
        #expect(throws: Error.self) {
            _ = try NodeAppModel._test_decodeParams(OpenClawCanvasNavigateParams.self, from: nil)
        }
    }

    @Test @MainActor func `encode payload emits JSON`() throws {
        struct Payload: Codable, Equatable {
            var value: String
        }
        let json = try NodeAppModel._test_encodePayload(Payload(value: "ok"))
        #expect(json.contains("\"value\""))
    }

    @Test @MainActor func `chat session key defaults to main base`() {
        let appModel = NodeAppModel()
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func `init preserves saved talk mode preference`() {
        withUserDefaults(["talk.enabled": true]) {
            let talkMode = TalkModeManager(allowSimulatorCapture: true)
            let appModel = NodeAppModel(talkMode: talkMode)

            #expect(UserDefaults.standard.bool(forKey: "talk.enabled"))
            #expect(appModel.talkMode.isEnabled)
        }
    }

    @Test @MainActor func `chat session key uses agent scoped key for non default agent`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("agent-123")
        #expect(appModel.chatSessionKey == SessionKey.makeAgentSessionKey(agentId: "agent-123", baseKey: "main"))
        #expect(appModel.mainSessionKey == "agent:agent-123:main")
    }

    @Test @MainActor func `session key extracts canonical agent ID`() {
        #expect(SessionKey.agentId(from: "agent:rust-claw:mattermost:channel:w6g") == "rust-claw")
        #expect(SessionKey.agentId(from: " agent:main:main ") == "main")
        #expect(SessionKey.agentId(from: "main") == nil)
        #expect(SessionKey.agentId(from: "agent::main") == nil)
        #expect(SessionKey.agentId(from: nil) == nil)
    }

    @Test @MainActor func `chat agent name uses focused canonical session agent`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "main",
                name: "Joshtimus Prime",
                identity: nil,
                workspace: nil,
                model: nil,
                agentruntime: nil),
            AgentSummary(
                id: "rust-claw",
                name: "Rust Claw",
                identity: nil,
                workspace: nil,
                model: nil,
                agentruntime: nil),
        ]
        appModel.setSelectedAgentId("main")

        appModel.openChat(sessionKey: "agent:rust-claw:mattermost:channel:w6gjp6iz3fyp3fo15q4fwfpnno")

        #expect(appModel.selectedAgentId == "main")
        #expect(appModel.activeAgentName == "Joshtimus Prime")
        #expect(appModel.chatAgentId == "rust-claw")
        #expect(appModel.chatAgentName == "Rust Claw")
    }

    @Test @MainActor func `chat agent name falls back to selected agent for unscoped session`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "rust-claw",
                name: "Rust Claw",
                identity: nil,
                workspace: nil,
                model: nil,
                agentruntime: nil),
        ]
        appModel.setSelectedAgentId("rust-claw")

        appModel.openChat(sessionKey: "incident-42")

        #expect(appModel.chatAgentId == "rust-claw")
        #expect(appModel.chatAgentName == "Rust Claw")
    }

    @Test @MainActor func `selecting agent clears explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        let rustSessionKey = SessionKey.makeAgentSessionKey(agentId: "rust-claw", baseKey: "main")

        appModel.setSelectedAgentId("rust-claw")
        #expect(appModel.chatSessionKey == rustSessionKey)
        appModel.focusChatSession(rustSessionKey)

        appModel.setSelectedAgentId("main")
        #expect(appModel.defaultChatSessionKey == "main")
        #expect(appModel.mainSessionKey == "main")
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func `same selected agent keeps explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("main")
        appModel.openChat(sessionKey: "incident-42")

        appModel.setSelectedAgentId("main")
        #expect(appModel.defaultChatSessionKey == "main")
        #expect(appModel.chatSessionKey == "incident-42")
    }

    @Test @MainActor func `default chat session key ignores explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("rust-claw")
        appModel.openChat(sessionKey: "incident-42")

        #expect(appModel.defaultChatSessionKey == SessionKey.makeAgentSessionKey(
            agentId: "rust-claw",
            baseKey: "main"))
        #expect(appModel.chatSessionKey == "incident-42")
    }

    @Test @MainActor func `opening nil chat session clears explicit chat focus`() {
        let appModel = NodeAppModel()
        appModel.gatewayDefaultAgentId = "main"
        appModel.setSelectedAgentId("rust-claw")
        appModel.openChat(sessionKey: "incident-42")

        appModel.openChat(sessionKey: nil)

        #expect(appModel.chatSessionKey == SessionKey.makeAgentSessionKey(
            agentId: "rust-claw",
            baseKey: "main"))

        appModel.setSelectedAgentId("main")
        #expect(appModel.chatSessionKey == "main")
    }

    @Test @MainActor func `exec approval prompt presentation tracks latest notification tap`() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-1",
                    commandText: "echo first",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: "main",
                    expiresAtMs: 1)))

        let firstPrompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(firstPrompt.id == "approval-1")
        #expect(firstPrompt.commandText == "echo first")
        #expect(firstPrompt.allowsAllowAlways == false)

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-2",
                    commandText: "echo second",
                    allowedDecisions: ["allow-once", "allow-always", "deny"],
                    host: "gateway",
                    nodeId: "node-2",
                    agentId: nil,
                    expiresAtMs: 2)))

        let secondPrompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(secondPrompt.id == "approval-2")
        #expect(secondPrompt.commandText == "echo second")
        #expect(secondPrompt.allowsAllowAlways)

        appModel._test_dismissPendingExecApprovalPrompt()
        #expect(appModel._test_pendingExecApprovalPrompt() == nil)
    }

    @Test @MainActor func `gateway switch invalidates privileged approval surfaces`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [
            NotificationSnapshot(
                identifier: "old-requested-approval",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "recovery-a",
                        "gatewayDeviceId": "device-a",
                    ],
                ]),
            NotificationSnapshot(
                identifier: "new-requested-approval",
                userInfo: [
                    "openclaw": [
                        "kind": ExecApprovalNotificationBridge.requestedKind,
                        "approvalId": "recovery-b",
                        "gatewayDeviceId": "device-b",
                    ],
                ]),
        ]
        let appModel = NodeAppModel(
            notificationCenter: notificationCenter,
            watchMessagingService: watchService)
        defer { appModel.disconnectGateway() }
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "ios",
            clientMode: "node",
            clientDisplayName: "Phone")
        let gatewayA = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "gateway-a",
            tls: nil,
            token: "token-a",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        let gatewayB = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:2")),
            stableID: "gateway-b",
            tls: nil,
            token: "token-b",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)

        appModel.applyGatewayConnectConfig(gatewayA)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "shared-approval-id",
                gatewayStableID: gatewayA.effectiveStableID,
                commandText: "deploy gateway A",
                allowedDecisions: ["allow-once", "deny"],
                host: "gateway-a",
                nodeId: nil,
                agentId: "main",
                expiresAtMs: nil)))
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            "recovery-a",
            gatewayDeviceId: "device-a")

        appModel.applyGatewayConnectConfig(gatewayB)
        for _ in 0..<1000
            where notificationCenter.deliveredRemovedIdentifiers.isEmpty
            || watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty != true
        {
            await Task.yield()
        }

        #expect(appModel._test_pendingExecApprovalPrompt() == nil)
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs().isEmpty)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.isEmpty == true)
        #expect(notificationCenter.pendingRemovedIdentifiers.contains([
            "exec.approval.device-a.recovery-a",
        ]))
        #expect(notificationCenter.deliveredRemovedIdentifiers.contains([
            "old-requested-approval",
        ]))
        #expect(!notificationCenter.deliveredRemovedIdentifiers
            .flatMap(\.self)
            .contains("new-requested-approval"))

        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "shared-approval-id",
                gatewayStableID: gatewayB.effectiveStableID,
                commandText: "deploy gateway B",
                allowedDecisions: ["allow-once", "deny"],
                host: "gateway-b",
                nodeId: nil,
                agentId: "main",
                expiresAtMs: nil)))

        watchService.emitExecApprovalResolve(WatchExecApprovalResolveEvent(
            replyId: "stale-watch-reply",
            approvalId: "shared-approval-id",
            gatewayStableID: gatewayA.effectiveStableID,
            decision: .allowOnce,
            sentAtMs: nil,
            transport: "test"))
        await Task.yield()
        await Task.yield()

        #expect(watchService.lastSentExecApprovalResolved == nil)
        #expect(watchService.lastSentExecApprovalExpired == nil)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.first?.gatewayStableID == gatewayB
            .effectiveStableID)
    }

    @Test @MainActor func `offline resolution push remains durable until its gateway reconnects`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-resolved-offline",
            gatewayDeviceId: "gateway-device-a")
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "offline-request-alert",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": push.approvalId,
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let firstModel = NodeAppModel(notificationCenter: notificationCenter)

        #expect(await firstModel.handleExecApprovalResolvedRemotePush(push))
        #expect(firstModel._test_pendingExecApprovalResolvedPushes() == [push])
        #expect(notificationCenter.pendingRemovedIdentifiers == [[
            "exec.approval.gateway-device-a.approval-resolved-offline",
        ]])
        #expect(notificationCenter.deliveredRemovedIdentifiers == [["offline-request-alert"]])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel._test_pendingExecApprovalResolvedPushes() == [push])
    }

    @Test @MainActor func `offline approval request remains durable until its gateway reconnects`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-requested-offline",
            gatewayDeviceId: "gateway-device-a")
        let firstModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())

        #expect(await firstModel.handleExecApprovalRequestedRemotePush(push))
        #expect(firstModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])
    }

    @Test @MainActor func `offline approval notification tap retains watch recovery`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let push = ExecApprovalNotificationPrompt(
            approvalId: "approval-notification-offline",
            gatewayDeviceId: "gateway-device-a")
        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())

        await appModel.presentExecApprovalNotificationPrompt(push)

        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == [push.approvalId])
    }

    @Test @MainActor func `late watch snapshot is repaired after gateway switch`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let gate = WatchSnapshotSendGate()
        var shouldBlockNextSnapshot = true
        watchService.syncExecApprovalSnapshotHandler = { _ in
            if shouldBlockNextSnapshot {
                shouldBlockNextSnapshot = false
                await gate.wait()
            }
            return watchService.nextSendResult
        }
        let appModel = NodeAppModel(watchMessagingService: watchService)
        defer { appModel.disconnectGateway() }
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "ios",
            clientMode: "node",
            clientDisplayName: "Phone")
        let gatewayA = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: "watch-route-a",
            tls: nil,
            token: "token-a",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        let gatewayB = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:2")),
            stableID: "watch-route-b",
            tls: nil,
            token: "token-b",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)

        appModel.applyGatewayConnectConfig(gatewayA)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-route-a",
                gatewayStableID: gatewayA.effectiveStableID,
                commandText: "route A",
                allowedDecisions: ["deny"],
                host: nil,
                nodeId: nil,
                agentId: nil,
                expiresAtMs: nil)))
        while await !(gate.hasStarted()) {
            await Task.yield()
        }

        appModel.applyGatewayConnectConfig(gatewayB)
        try appModel._test_presentExecApprovalPrompt(#require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-route-b",
                gatewayStableID: gatewayB.effectiveStableID,
                commandText: "route B",
                allowedDecisions: ["deny"],
                host: nil,
                nodeId: nil,
                agentId: nil,
                expiresAtMs: nil)))
        await gate.resume()

        for _ in 0..<1000
            where watchService.sentExecApprovalSnapshots.count < 3
            || watchService.lastSentExecApprovalSnapshot?.approvals.first?.gatewayStableID
            != gatewayB.effectiveStableID
        {
            await Task.yield()
        }
        #expect(watchService.sentExecApprovalSnapshots.count >= 3)
        #expect(watchService.lastSentExecApprovalSnapshot?.approvals.map(\.gatewayStableID) == [
            gatewayB.effectiveStableID,
        ])
    }

    @Test @MainActor func `dismiss pending exec approval prompt by id leaves different prompt visible`() throws {
        let appModel = NodeAppModel()
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-active",
                    commandText: "echo keep",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: 1)))

        appModel.dismissPendingExecApprovalPrompt(approvalId: "approval-stale")

        let prompt = try #require(appModel._test_pendingExecApprovalPrompt())
        #expect(prompt.id == "approval-active")
    }

    @Test @MainActor func `presenting exec approval prompt syncs watch prompt`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let prompt = try #require(
            NodeAppModel._test_makeExecApprovalPrompt(
                id: "approval-watch-sync",
                commandText: "npm publish",
                allowedDecisions: ["allow-once", "deny"],
                host: "gateway",
                nodeId: "node-1",
                agentId: "main",
                expiresAtMs: 1234))

        appModel._test_presentExecApprovalPrompt(prompt)
        await Task.yield()

        let sent = try #require(watchService.lastSentExecApprovalPrompt)
        #expect(sent.approval.id == "approval-watch-sync")
        #expect(sent.approval.allowedDecisions == [.allowOnce, .deny])
        #expect(sent.approval.host == "gateway")
        #expect(sent.approval.risk == nil)
        #expect(sent.resetResolvingState != true)
    }

    @Test @MainActor func `watch exec approval snapshot request publishes cached approvals in background`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let futureExpiryMs = Int(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-snapshot",
                    commandText: "echo from watch",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        await Task.yield()

        appModel.setScenePhase(.background)
        watchService.emitExecApprovalSnapshotRequest(
            WatchExecApprovalSnapshotRequestEvent(
                requestId: "snapshot-1",
                sentAtMs: 111,
                transport: "sendMessage"))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentExecApprovalSnapshot)
        #expect(snapshot.approvals.map(\.id) == ["approval-watch-snapshot"])
    }

    @Test @MainActor func `watch exec approval snapshot request skips foreground recovery`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let futureExpiryMs = Int(Date().timeIntervalSince1970 * 1000) + 60000
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-foreground-skip",
                    commandText: "echo foreground",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: futureExpiryMs)))
        await Task.yield()
        watchService.lastSentExecApprovalSnapshot = nil

        watchService.emitExecApprovalSnapshotRequest(
            WatchExecApprovalSnapshotRequestEvent(
                requestId: "snapshot-foreground",
                sentAtMs: 222,
                transport: "sendMessage"))
        await Task.yield()

        #expect(watchService.lastSentExecApprovalSnapshot == nil)
    }

    @Test @MainActor func `watch app snapshot request publishes current dashboard state`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setGatewayConnected(true)
        appModel._test_setOperatorConnected(true)
        appModel._test_setConnectedGatewayID("gateway-watch-snapshot")
        appModel.gatewayStatusText = "Connected"
        appModel.talkMode.setEnabled(true)
        appModel.talkMode.statusText = "Listening"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-1",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot != nil {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.gatewayConnected == true)
        #expect(snapshot.gatewayStatusText == "Connected")
        #expect(snapshot.agentName == "Main")
        #expect(snapshot.sessionKey == "main")
        #expect(snapshot.gatewayStableID == "gateway-watch-snapshot")
        #expect(!snapshot.talkStatusText.isEmpty)
        #expect(snapshot.talkEnabled == true)
        #expect(snapshot.pendingApprovalCount == 0)
    }

    @Test @MainActor func `watch app snapshot publishes offline when operator disconnects`() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setGatewayConnected(true)
        appModel._test_setOperatorConnected(true)
        appModel.gatewayStatusText = "Connected"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-before-disconnect",
                sentAtMs: 123,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == true {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == true)

        appModel.disconnectGateway()
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == false {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == false)
        #expect(watchService.lastSentAppSnapshot?.gatewayStatusText == "Offline")
    }

    @Test @MainActor func `watch app snapshot publishes online when operator reconnects`() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setGatewayConnected(true)
        appModel.gatewayStatusText = "Connected"

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-before-reconnect",
                sentAtMs: 124,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == false {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == false)

        appModel._test_setOperatorConnected(true)
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.gatewayConnected == true {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.gatewayConnected == true)
        #expect(watchService.lastSentAppSnapshot?.gatewayStatusText == "Connected")
    }

    @Test @MainActor func `watch app snapshot uses configured agent avatar`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel.gatewayDefaultAgentId = "main"
        appModel.gatewayAgents = [
            AgentSummary(
                id: "main",
                name: "Main",
                identity: [
                    "avatarUrl": AnyCodable("https://example.com/openclaw.png"),
                    "emoji": AnyCodable("OC"),
                ],
                workspace: nil,
                model: nil,
                agentruntime: nil),
        ]

        watchService.emitAppSnapshotRequest(
            WatchAppSnapshotRequestEvent(
                requestId: "app-snapshot-avatar",
                sentAtMs: 124,
                transport: "sendMessage"))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.agentAvatarURL == "https://example.com/openclaw.png")
        #expect(snapshot.agentAvatarText == "OC")
    }

    @Test @MainActor func `watch app snapshot includes pending approval count`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-app-count",
                    commandText: "rm -rf build",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "Mac",
                    nodeId: "node-1",
                    agentId: "agent-1",
                    expiresAtMs: nil)))
        await Task.yield()

        let snapshot = try #require(watchService.lastSentAppSnapshot)
        #expect(snapshot.pendingApprovalCount == 1)
    }

    @Test @MainActor func `watch app command controls talk through phone model`() async {
        let watchService = MockWatchMessagingService()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(watchMessagingService: watchService, talkMode: talkMode)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-start-talk",
                command: .startTalk,
                sessionKey: "main",
                gatewayStableID: nil,
                text: nil,
                sentAtMs: 123,
                transport: "sendMessage"))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == true)
        #expect(watchService.lastSentAppSnapshot?.talkEnabled == true)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-stop-talk",
                command: .stopTalk,
                sessionKey: "main",
                gatewayStableID: nil,
                text: nil,
                sentAtMs: 124,
                transport: "sendMessage"))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == false)
        #expect(watchService.lastSentAppSnapshot?.talkEnabled == false)
    }

    @Test @MainActor func `watch app command opens chat session on phone model`() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-open-chat",
                command: .openChat,
                sessionKey: "incident-42",
                gatewayStableID: nil,
                text: nil,
                sentAtMs: 125,
                transport: "sendMessage"))
        await Task.yield()

        #expect(appModel.chatSessionKey == "incident-42")
        #expect(watchService.lastSentAppSnapshot?.sessionKey == "incident-42")
    }

    @Test @MainActor func `watch app commands reject stale gateway targets`() async {
        let watchService = MockWatchMessagingService()
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(watchMessagingService: watchService, talkMode: talkMode)
        appModel._test_setConnectedGatewayID("gateway-current")
        appModel.setTalkEnabled(false)

        for command in [OpenClawWatchAppCommand.openChat, .startTalk] {
            watchService.emitAppCommand(
                WatchAppCommandEvent(
                    commandId: "watch-stale-\(command.rawValue)",
                    command: command,
                    sessionKey: "stale-session",
                    gatewayStableID: "gateway-stale",
                    text: nil,
                    sentAtMs: 125,
                    transport: "transferUserInfo"))
            await Task.yield()
        }

        #expect(appModel.chatSessionKey != "stale-session")
        #expect(appModel.talkMode.isEnabled == false)

        appModel.setTalkEnabled(true)
        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-stale-stop-talk",
                command: .stopTalk,
                sessionKey: "stale-session",
                gatewayStableID: "gateway-stale",
                text: nil,
                sentAtMs: 126,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel.talkMode.isEnabled == true)
    }

    @Test @MainActor func `watch app command sends chat message through phone model`() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel.enterAppleReviewDemoMode()

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: AppleReviewDemoMode.gatewayID,
                text: "Watch says hello",
                sentAtMs: 126,
                transport: "sendMessage"))
        for _ in 0..<20 {
            if watchService.lastSentAppSnapshot?.chatItems?.contains(where: { item in
                item.role == "user" && item.text.contains("Watch says hello")
            }) == true {
                break
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(watchService.lastSentAppSnapshot?.chatItems?.contains { item in
            item.role == "user" && item.text.contains("Watch says hello")
        } == true)
    }

    @Test func `watch chat preview keeps older readable messages after internal events`() throws {
        var rawMessages = try [
            makeWatchChatRawMessage(
                role: "assistant",
                text: "Still worth reading",
                timestamp: 1000),
        ]
        for index in 0..<30 {
            try rawMessages.append(
                makeWatchChatRawMessage(
                    role: "assistant",
                    text: nil,
                    type: "toolCall",
                    timestamp: 2000 + Double(index)))
        }

        let items = NodeAppModel._test_makeWatchChatItems(from: rawMessages)

        #expect(items.map(\.text) == ["Still worth reading"])
    }

    @Test @MainActor func `watch app command queues chat message when operator offline`() async {
        NodeAppModel._test_resetPersistedWatchChatQueueState()
        defer { NodeAppModel._test_resetPersistedWatchChatQueueState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let gatewayID = "gateway-watch-chat-offline"
        appModel._test_setConnectedGatewayID(gatewayID)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-offline",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: gatewayID,
                text: "Queue this from watch",
                sentAtMs: 127,
                transport: "sendMessage"))
        await Task.yield()

        #expect(appModel._test_queuedWatchChatCommandCount() == 1)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-offline",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: gatewayID,
                text: "Queue this from watch",
                sentAtMs: 128,
                transport: "sendMessage"))
        await Task.yield()

        #expect(appModel._test_queuedWatchChatCommandCount() == 1)
    }

    @Test @MainActor func `watch app command queues until cold launch restores its gateway`() async {
        NodeAppModel._test_resetPersistedWatchChatQueueState()
        defer { NodeAppModel._test_resetPersistedWatchChatQueueState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-before-route",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: "gateway-cold-launch",
                text: "Keep this until startup restores the route",
                sentAtMs: 127,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel._test_queuedWatchChatCommandCount() == 1)
        #expect(watchService.lastSentAppSnapshot == nil)
    }

    @Test @MainActor func `watch app command drops chat message for stale gateway snapshot`() async {
        NodeAppModel._test_resetPersistedWatchChatQueueState()
        defer { NodeAppModel._test_resetPersistedWatchChatQueueState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setConnectedGatewayID("gateway-current")

        watchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-stale-gateway",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: "gateway-from-old-snapshot",
                text: "Do not send to the new gateway",
                sentAtMs: 128,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel._test_queuedWatchChatCommandCount() == 0)
    }

    @Test @MainActor func `watch app command restores queued chat message after model restart`() async {
        NodeAppModel._test_resetPersistedWatchChatQueueState()
        defer { NodeAppModel._test_resetPersistedWatchChatQueueState() }

        let gatewayID = "gateway-watch-chat-restore"
        let firstWatchService = MockWatchMessagingService()
        let firstAppModel = NodeAppModel(watchMessagingService: firstWatchService)
        firstAppModel._test_setConnectedGatewayID(gatewayID)
        firstWatchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-restore",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: gatewayID,
                text: "Keep this through restart",
                sentAtMs: 129,
                transport: "sendMessage"))
        await Task.yield()

        #expect(firstAppModel._test_queuedWatchChatCommandIds() == ["watch-send-chat-restore"])

        let secondWatchService = MockWatchMessagingService()
        let secondAppModel = NodeAppModel(watchMessagingService: secondWatchService)
        secondAppModel._test_setConnectedGatewayID(gatewayID)

        #expect(secondAppModel._test_queuedWatchChatCommandIds() == ["watch-send-chat-restore"])

        secondWatchService.emitAppCommand(
            WatchAppCommandEvent(
                commandId: "watch-send-chat-restore",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: gatewayID,
                text: "Keep this through restart",
                sentAtMs: 130,
                transport: "transferUserInfo"))
        await Task.yield()

        #expect(secondAppModel._test_queuedWatchChatCommandIds() == ["watch-send-chat-restore"])
    }

    @Test @MainActor func `watch chat queue scopes and orders commands by gateway`() throws {
        let suiteName = "watch-chat-queue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchChatCoordinator(defaults: defaults)
        let first = WatchAppCommandEvent(
            commandId: "watch-send-chat-gateway-a-1",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: "gateway-a",
            text: "First for gateway A",
            sentAtMs: 131,
            transport: "sendMessage")
        let second = WatchAppCommandEvent(
            commandId: "watch-send-chat-gateway-a-2",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: "gateway-a",
            text: "Second for gateway A",
            sentAtMs: 132,
            transport: "sendMessage")

        if case .queue = coordinator.ingest(first, isChatAvailable: false, gatewayStableID: "gateway-a") {
        } else {
            Issue.record("expected first gateway A command to queue")
        }
        if case .queue = coordinator.ingest(second, isChatAvailable: false, gatewayStableID: "gateway-a") {
        } else {
            Issue.record("expected second gateway A command to queue")
        }

        #expect(coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-b") == nil)
        coordinator.removeQueuedCommand(
            commandId: "watch-send-chat-gateway-a-1",
            gatewayStableID: "gateway-b")

        #expect(
            coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-1")
        #expect(
            coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-1")

        coordinator.removeQueuedCommand(
            commandId: "watch-send-chat-gateway-a-1",
            gatewayStableID: "gateway-a")
        #expect(
            coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-gateway-a-2")
    }

    @Test @MainActor func `watch chat requeue keeps original gateway owner`() throws {
        let suiteName = "watch-chat-requeue-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchChatCoordinator(defaults: defaults)
        let event = WatchAppCommandEvent(
            commandId: "watch-send-chat-retry-gateway-a",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: "gateway-a",
            text: "Retry for gateway A",
            sentAtMs: 133,
            transport: "sendMessage")

        coordinator.requeueFront(event, gatewayStableID: event.gatewayStableID)

        #expect(coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-b") == nil)
        #expect(
            coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-a")?.commandId ==
                "watch-send-chat-retry-gateway-a")
    }

    @Test @MainActor func `watch chat restore backfills gateway owner into legacy queued event`() throws {
        let suiteName = "watch-chat-restore-legacy-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }
        let legacyQueueJSON = """
        [
          {
            "gatewayStableID": "gateway-a",
            "event": {
              "commandId": "watch-send-chat-legacy",
              "command": "send-chat",
              "sessionKey": "main",
              "text": "Legacy queued text",
              "sentAtMs": 134,
              "transport": "transferUserInfo"
            }
          }
        ]
        """
        defaults.set(
            Data(legacyQueueJSON.utf8),
            forKey: "watch.chat.command.queue.v1")

        let coordinator = WatchChatCoordinator(defaults: defaults)
        let restored = coordinator.nextQueuedCommand(isChatAvailable: true, gatewayStableID: "gateway-a")

        #expect(restored?.commandId == "watch-send-chat-legacy")
        #expect(restored?.gatewayStableID == "gateway-a")
    }

    @Test @MainActor func `watch chat command deduping keeps only recent forwarded commands`() throws {
        let suiteName = "watch-chat-recent-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchChatCoordinator(defaults: defaults)
        for index in 0..<140 {
            let event = WatchAppCommandEvent(
                commandId: "watch-forward-\(index)",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: nil,
                text: "Message \(index)",
                sentAtMs: index,
                transport: "sendMessage")
            if case .forward = coordinator.ingest(
                event,
                isChatAvailable: true,
                gatewayStableID: "gateway-a")
            {
            } else {
                Issue.record("expected forwarded command \(index)")
            }
        }

        let oldestEvent = WatchAppCommandEvent(
            commandId: "watch-forward-0",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: nil,
            text: "Message 0 again",
            sentAtMs: 999,
            transport: "sendMessage")
        if case .forward = coordinator.ingest(
            oldestEvent,
            isChatAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected oldest forwarded command to age out of dedupe")
        }

        let recentEvent = WatchAppCommandEvent(
            commandId: "watch-forward-139",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: nil,
            text: "Message 139 again",
            sentAtMs: 1000,
            transport: "sendMessage")
        if case .deduped = coordinator.ingest(
            recentEvent,
            isChatAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected recent forwarded command to stay deduped")
        }
    }

    @Test @MainActor func `watch chat command deduping keeps delivered queued commands recent`() throws {
        let suiteName = "watch-chat-delivered-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer {
            defaults.removePersistentDomain(forName: suiteName)
        }

        let coordinator = WatchChatCoordinator(defaults: defaults)
        for index in 0..<140 {
            let event = WatchAppCommandEvent(
                commandId: "watch-queued-\(index)",
                command: .sendChat,
                sessionKey: "main",
                gatewayStableID: nil,
                text: "Queued \(index)",
                sentAtMs: index,
                transport: "transferUserInfo")
            if case .queue = coordinator.ingest(
                event,
                isChatAvailable: false,
                gatewayStableID: "gateway-a")
            {
            } else {
                Issue.record("expected queued command \(index)")
            }
        }

        coordinator.removeQueuedCommand(
            commandId: "watch-queued-0",
            gatewayStableID: "gateway-a")

        let duplicateDeliveredEvent = WatchAppCommandEvent(
            commandId: "watch-queued-0",
            command: .sendChat,
            sessionKey: "main",
            gatewayStableID: nil,
            text: "Duplicate after delivery",
            sentAtMs: 999,
            transport: "transferUserInfo")
        if case .deduped = coordinator.ingest(
            duplicateDeliveredEvent,
            isChatAvailable: true,
            gatewayStableID: "gateway-a")
        {
        } else {
            Issue.record("expected delivered queued command to stay deduped")
        }
    }

    @Test @MainActor func `pending watch recovery I ds are included without delivered notifications`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_recordPendingWatchExecApprovalRecoveryID("approval-watch-recovery")

        let ids = await appModel._test_pendingExecApprovalIDsForWatchRecovery()
        #expect(ids == ["approval-watch-recovery"])
    }

    @Test @MainActor func `delivered approval becomes durable watch recovery`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "delivered-approval",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-delivered-recovery",
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let firstModel = NodeAppModel(notificationCenter: notificationCenter)

        #expect(await firstModel._test_pendingExecApprovalIDsForWatchRecovery() == [
            "approval-delivered-recovery",
        ])
        #expect(firstModel._test_pendingWatchExecApprovalRecoveryIDs() == [
            "approval-delivered-recovery",
        ])

        let restoredModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        #expect(restoredModel._test_pendingWatchExecApprovalRecoveryIDs() == [
            "approval-delivered-recovery",
        ])
    }

    @Test @MainActor func `route prompt cannot clear ownerful push recovery`() throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }

        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_recordPendingWatchExecApprovalRecoveryID("approval-watch-clear")
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-watch-clear"])

        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-watch-clear",
                    commandText: "echo clear",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: Int(Date().timeIntervalSince1970 * 1000) + 60000)))

        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-watch-clear"])
    }

    @Test func `approval notification error classification prefers structured details`() {
        let staleError = GatewayResponseError(
            method: "exec.approval.get",
            code: "INVALID_REQUEST",
            message: "gateway error",
            details: ["reason": AnyCodable("APPROVAL_NOT_FOUND")])
        let unavailableError = GatewayResponseError(
            method: "exec.approval.resolve",
            code: "INVALID_REQUEST",
            message: "gateway error",
            details: ["reason": AnyCodable("APPROVAL_ALLOW_ALWAYS_UNAVAILABLE")])

        #expect(NodeAppModel._test_isApprovalNotificationStaleError(staleError))
        #expect(NodeAppModel._test_isApprovalNotificationUnavailableError(unavailableError))
    }

    @Test func `background aware exec approval reconnect covers watch and push paths`() {
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "push_request",
                isBackgrounded: true))
        #expect(
            NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_resolve",
                isBackgrounded: true))
        #expect(
            !NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "direct",
                isBackgrounded: true))
        #expect(
            !NodeAppModel._test_shouldUseBackgroundAwareExecApprovalReconnect(
                sourceReason: "watch_request",
                isBackgrounded: false))
    }

    @Test func `exec approval event ID decodes gateway payload`() {
        #expect(NodeAppModel._test_execApprovalEventID(from: AnyCodable(["id": " approval-1 "])) == "approval-1")
        #expect(NodeAppModel._test_execApprovalEventID(from: AnyCodable(["id": "   "])) == nil)
        #expect(NodeAppModel._test_execApprovalEventID(from: AnyCodable(["other": "approval-1"])) == nil)
    }

    @Test @MainActor func `operator gateway resolved event leaves unvalidated push recovery`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let notificationCenter = MockBootstrapNotificationCenter()
        notificationCenter.delivered = [NotificationSnapshot(
            identifier: "approval-event-notification",
            userInfo: [
                "openclaw": [
                    "kind": ExecApprovalNotificationBridge.requestedKind,
                    "approvalId": "approval-event-resolved",
                    "gatewayDeviceId": "gateway-device-a",
                ],
            ])]
        let appModel = NodeAppModel(notificationCenter: notificationCenter)
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            "approval-event-resolved",
            gatewayDeviceId: "gateway-device-a")
        try appModel._test_presentExecApprovalPrompt(
            #require(
                NodeAppModel._test_makeExecApprovalPrompt(
                    id: "approval-event-resolved",
                    commandText: "echo clear",
                    allowedDecisions: ["allow-once", "deny"],
                    host: "gateway",
                    nodeId: nil,
                    agentId: nil,
                    expiresAtMs: Int(Date().timeIntervalSince1970 * 1000) + 60000)))

        await appModel._test_handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.resolvedKind,
            payload: AnyCodable(["id": "approval-event-resolved"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel._test_pendingExecApprovalPrompt() == nil)
        #expect(appModel._test_pendingWatchExecApprovalRecoveryIDs() == ["approval-event-resolved"])
        #expect(!notificationCenter.deliveredRemovedIdentifiers.contains([
            "approval-event-notification",
        ]))
    }

    @Test @MainActor func `validated resolved push clears only its gateway recovery`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let appModel = NodeAppModel(notificationCenter: MockBootstrapNotificationCenter())
        appModel._test_setConnectedGatewayID("gateway-a")
        let gatewayA = ExecApprovalNotificationPrompt(
            approvalId: "shared-approval-id",
            gatewayDeviceId: "gateway-device-a")
        let gatewayB = ExecApprovalNotificationPrompt(
            approvalId: "shared-approval-id",
            gatewayDeviceId: "gateway-device-b")
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            gatewayA.approvalId,
            gatewayDeviceId: "gateway-device-a")
        appModel._test_recordPendingWatchExecApprovalRecoveryID(
            gatewayB.approvalId,
            gatewayDeviceId: "gateway-device-b")

        await appModel._test_handleExecApprovalResolvedForCurrentGateway(
            approvalId: gatewayA.approvalId,
            recoveryPushGatewayDeviceID: gatewayA.gatewayDeviceId)

        #expect(appModel._test_pendingWatchExecApprovalRecoveryPushes() == [gatewayB])
    }

    @Test func `watch exec approval hydrate fetches only missing I ds`() {
        let idsToFetch = NodeAppModel._test_watchExecApprovalIDsNeedingFetch(
            candidateIDs: ["cached", "pending", "cached", "other", "", "  pending  "],
            cachedApprovalIDs: ["cached", "also-cached"])

        #expect(idsToFetch == ["pending", "other"])
    }

    @Test func `watch exec approval retry prompt resets resolving state only for retry reason`() {
        #expect(NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "resolve_retry"))
        #expect(!NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "push_request"))
        #expect(!NodeAppModel._test_shouldResetWatchExecApprovalResolvingStateOnPrompt(reason: "present_prompt"))
    }

    @Test func `operator loop waits for bootstrap handoff before using stored token`() {
        #expect(
            !NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            !NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: false))
        #expect(
            NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: nil,
                bootstrapToken: nil,
                password: nil,
                hasStoredOperatorToken: true))
        #expect(
            NodeAppModel._test_shouldStartOperatorGatewayLoop(
                token: "shared-token",
                bootstrapToken: "fresh-bootstrap-token",
                password: nil,
                hasStoredOperatorToken: false))
    }

    @Test func `credential handoff is required only for bootstrap authentication`() {
        #expect(NodeAppModel._test_usesBootstrapCredential(
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil))
        #expect(!NodeAppModel._test_usesBootstrapCredential(
            token: "shared-token",
            bootstrapToken: "fresh-bootstrap-token",
            password: nil))
        #expect(!NodeAppModel._test_usesBootstrapCredential(
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: "shared-password"))
        #expect(!NodeAppModel._test_usesBootstrapCredential(
            token: nil,
            bootstrapToken: nil,
            password: nil))
    }

    @Test @MainActor func `operator gateway requested event shows notification guidance when notifications off`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .notDetermined
        let appModel = NodeAppModel(notificationCenter: center)
        appModel._test_resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel._test_resetExecApprovalNotificationGuidanceSuppression() }

        await appModel._test_handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-notifications-off"]),
            seq: nil,
            stateversion: nil))

        let prompt = try #require(appModel._test_pendingNotificationPermissionGuidancePrompt())
        #expect(prompt.approvalId == "approval-notifications-off")
    }

    @Test @MainActor func `stale operator event cannot mutate approval UI after suspension`() async {
        let center = MockBootstrapNotificationCenter()
        let authorizationGate = NotificationAuthorizationGate()
        center.authorizationStatusHandler = { await authorizationGate.wait() }
        let appModel = NodeAppModel(notificationCenter: center)
        appModel._test_resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel._test_resetExecApprovalNotificationGuidanceSuppression() }
        var routeIsCurrent = true
        let event = EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-stale-route"]),
            seq: nil,
            stateversion: nil)

        let handling = Task { @MainActor in
            await appModel._test_handleOperatorGatewayServerEvent(
                event,
                shouldContinue: { routeIsCurrent })
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while await !(authorizationGate.hasStarted()), ContinuousClock().now < deadline {
            await Task.yield()
        }
        routeIsCurrent = false
        await authorizationGate.resume(returning: .denied)
        await handling.value

        #expect(appModel._test_pendingNotificationPermissionGuidancePrompt() == nil)
        #expect(appModel._test_pendingExecApprovalPrompt() == nil)
    }

    @Test @MainActor func `suppressed operator gateway requested event does not show notification guidance`() async {
        let center = MockBootstrapNotificationCenter()
        center.status = .denied
        let appModel = NodeAppModel(notificationCenter: center)
        appModel._test_resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel._test_resetExecApprovalNotificationGuidanceSuppression() }
        appModel.dismissNotificationPermissionGuidancePrompt(suppressFuture: true)

        await appModel._test_handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-suppressed"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel._test_pendingNotificationPermissionGuidancePrompt() == nil)
    }

    @Test @MainActor func `operator gateway resolved event clears notification guidance prompt`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .denied
        let appModel = NodeAppModel(notificationCenter: center)
        appModel._test_resetExecApprovalNotificationGuidanceSuppression()
        defer { appModel._test_resetExecApprovalNotificationGuidanceSuppression() }

        await appModel._test_handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.requestedKind,
            payload: AnyCodable(["id": "approval-guidance-resolved"]),
            seq: nil,
            stateversion: nil))
        _ = try #require(appModel._test_pendingNotificationPermissionGuidancePrompt())

        await appModel._test_handleOperatorGatewayServerEvent(EventFrame(
            type: "event",
            event: ExecApprovalNotificationBridge.resolvedKind,
            payload: AnyCodable(["id": "approval-guidance-resolved"]),
            seq: nil,
            stateversion: nil))

        #expect(appModel._test_pendingNotificationPermissionGuidancePrompt() == nil)
    }

    @Test @MainActor func `handle invoke rejects background commands`() async {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)

        let req = BridgeInvokeRequest(id: "bg", command: OpenClawCanvasCommand.present.rawValue)
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .backgroundUnavailable)
    }

    @Test @MainActor func `handle invoke rejects camera when disabled`() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "cam", command: OpenClawCameraCommand.snap.rawValue)

        let defaults = UserDefaults.standard
        let key = "camera.enabled"
        let previous = defaults.object(forKey: key)
        defaults.set(false, forKey: key)
        defer {
            if let previous {
                defaults.set(previous, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("CAMERA_DISABLED") == true)
    }

    @Test @MainActor func `system notify returns unavailable when notifications off`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .notDetermined
        let appModel = NodeAppModel(notificationCenter: center)
        let params = OpenClawSystemNotifyParams(title: "Approval", body: "Review request")
        let paramsData = try JSONEncoder().encode(params)
        let req = BridgeInvokeRequest(
            id: "notify-off",
            command: OpenClawSystemCommand.notify.rawValue,
            paramsJSON: String(decoding: paramsData, as: UTF8.self))

        let res = await appModel._test_handleInvoke(req)

        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message == "NOT_AUTHORIZED: notifications")
        #expect(center.addCalls == 0)
    }

    @Test @MainActor func `system notify schedules when notifications are already allowed`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .authorized
        let appModel = NodeAppModel(notificationCenter: center)
        let params = OpenClawSystemNotifyParams(title: "Approval", body: "Review request")
        let paramsData = try JSONEncoder().encode(params)
        let req = BridgeInvokeRequest(
            id: "notify-on",
            command: OpenClawSystemCommand.notify.rawValue,
            paramsJSON: String(decoding: paramsData, as: UTF8.self))

        let res = await appModel._test_handleInvoke(req)

        #expect(res.ok)
        #expect(center.addCalls == 1)
    }

    @Test @MainActor func `apns registration requires disclosure and notification authorization`() async {
        let center = MockBootstrapNotificationCenter()
        center.status = .authorized
        let appModel = NodeAppModel(notificationCenter: center)
        PushEnrollmentConsent.reset()
        defer { PushEnrollmentConsent.reset() }

        #expect(await appModel._test_canPublishAPNsRegistration() == false)
        #expect(await appModel._test_canPublishAPNsRegistration(usesRelayTransport: false) == false)

        PushEnrollmentConsent.markDisclosureAccepted()
        center.status = .notDetermined
        #expect(await appModel._test_canPublishAPNsRegistration() == false)

        center.status = .authorized
        #expect(await appModel._test_canPublishAPNsRegistration())
    }

    @Test @MainActor func `chat push without speech returns unavailable when notifications off`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .notDetermined
        let appModel = NodeAppModel(notificationCenter: center)
        let params = OpenClawChatPushParams(text: "Build finished", speak: false)
        let paramsData = try JSONEncoder().encode(params)
        let req = BridgeInvokeRequest(
            id: "chat-push-off",
            command: OpenClawChatCommand.push.rawValue,
            paramsJSON: String(decoding: paramsData, as: UTF8.self))

        let res = await appModel._test_handleInvoke(req)

        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message == "NOT_AUTHORIZED: notifications")
        #expect(center.addCalls == 0)
    }

    @Test @MainActor func `chat push schedules when notifications are already allowed`() async throws {
        let center = MockBootstrapNotificationCenter()
        center.status = .authorized
        let appModel = NodeAppModel(notificationCenter: center)
        let params = OpenClawChatPushParams(text: "Build finished", speak: false)
        let paramsData = try JSONEncoder().encode(params)
        let req = BridgeInvokeRequest(
            id: "chat-push-on",
            command: OpenClawChatCommand.push.rawValue,
            paramsJSON: String(decoding: paramsData, as: UTF8.self))

        let res = await appModel._test_handleInvoke(req)

        #expect(res.ok)
        #expect(center.addCalls == 1)
    }

    @Test @MainActor func `handle invoke rejects invalid screen format`() async {
        let appModel = NodeAppModel()
        let params = OpenClawScreenRecordParams(format: "gif")
        let data = try? JSONEncoder().encode(params)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }

        let req = BridgeInvokeRequest(
            id: "screen",
            command: OpenClawScreenCommand.record.rawValue,
            paramsJSON: json)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.message.contains("screen format must be mp4") == true)
    }

    @Test @MainActor func `handle invoke canvas commands update screen`() async throws {
        let appModel = NodeAppModel()
        let coordinator = try mountScreen(appModel.screen)
        defer { coordinator.teardown() }

        appModel.screen.navigate(to: "http://example.com")

        let present = BridgeInvokeRequest(id: "present", command: OpenClawCanvasCommand.present.rawValue)
        let presentRes = await appModel._test_handleInvoke(present)
        #expect(presentRes.ok == true)
        #expect(appModel.screen.urlString.isEmpty)

        // Loopback URLs are rejected (they are not meaningful for a remote gateway).
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)
        let navigate = BridgeInvokeRequest(
            id: "nav",
            command: OpenClawCanvasCommand.navigate.rawValue,
            paramsJSON: navJSON)
        let navRes = await appModel._test_handleInvoke(navigate)
        #expect(navRes.ok == true)
        #expect(appModel.screen.urlString == "http://example.com/")

        let evalParams = OpenClawCanvasEvalParams(javaScript: "1+1")
        let evalData = try JSONEncoder().encode(evalParams)
        let evalJSON = String(decoding: evalData, as: UTF8.self)
        let eval = BridgeInvokeRequest(
            id: "eval",
            command: OpenClawCanvasCommand.evalJS.rawValue,
            paramsJSON: evalJSON)
        var evalRes = await appModel._test_handleInvoke(eval)
        let deadline = ContinuousClock().now.advanced(by: .seconds(3))
        while evalRes.ok != true, ContinuousClock().now < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
            evalRes = await appModel._test_handleInvoke(eval)
        }
        #expect(evalRes.ok == true)
        let payloadData = try #require(evalRes.payloadJSON?.data(using: .utf8))
        let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        #expect(payload?["result"] as? String == "2")
    }

    @Test @MainActor func `pending foreground actions replay canvas navigate`() async throws {
        let appModel = NodeAppModel()
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)

        await appModel._test_applyPendingForegroundNodeActions([
            (
                id: "pending-nav-1",
                command: OpenClawCanvasCommand.navigate.rawValue,
                paramsJSON: navJSON),
        ])

        #expect(appModel.screen.urlString == "http://example.com/")
    }

    @Test @MainActor func `pending foreground actions do not apply while backgrounded`() async throws {
        let appModel = NodeAppModel()
        appModel.setScenePhase(.background)
        let navigateParams = OpenClawCanvasNavigateParams(url: "http://example.com/")
        let navData = try JSONEncoder().encode(navigateParams)
        let navJSON = String(decoding: navData, as: UTF8.self)

        await appModel._test_applyPendingForegroundNodeActions([
            (
                id: "pending-nav-bg",
                command: OpenClawCanvasCommand.navigate.rawValue,
                paramsJSON: navJSON),
        ])

        #expect(appModel.screen.urlString.isEmpty)
    }

    @Test @MainActor func `handle invoke A 2 UI commands fail when local host unavailable`() async throws {
        let appModel = NodeAppModel()

        let reset = BridgeInvokeRequest(id: "reset", command: OpenClawCanvasA2UICommand.reset.rawValue)
        let resetRes = await appModel._test_handleInvoke(reset)
        #expect(resetRes.ok == false)
        #expect(resetRes.error?.message.contains("A2UI_HOST_UNAVAILABLE") == true)

        let jsonl = "{\"beginRendering\":{}}"
        let pushParams = OpenClawCanvasA2UIPushJSONLParams(jsonl: jsonl)
        let pushData = try JSONEncoder().encode(pushParams)
        let pushJSON = String(decoding: pushData, as: UTF8.self)
        let push = BridgeInvokeRequest(
            id: "push",
            command: OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            paramsJSON: pushJSON)
        let pushRes = await appModel._test_handleInvoke(push)
        #expect(pushRes.ok == false)
        #expect(pushRes.error?.message.contains("A2UI_HOST_UNAVAILABLE") == true)
    }

    @Test @MainActor func `handle invoke unknown command returns invalid request`() async {
        let appModel = NodeAppModel()
        let req = BridgeInvokeRequest(id: "unknown", command: "nope")
        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
    }

    @Test @MainActor func `handle invoke watch status returns service snapshot`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.currentStatus = WatchMessagingStatus(
            supported: true,
            paired: true,
            appInstalled: true,
            reachable: false,
            activationState: "inactive")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let req = BridgeInvokeRequest(id: "watch-status", command: OpenClawWatchCommand.status.rawValue)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchStatusPayload.self, from: payloadData)
        #expect(payload.supported == true)
        #expect(payload.reachable == false)
        #expect(payload.activationState == "inactive")
    }

    @Test @MainActor func `handle invoke watch notify routes to watch service`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.nextSendResult = WatchNotificationSendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo")
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "OpenClaw",
            body: "Meeting with Peter is at 4pm",
            priority: .timeSensitive)
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req, gatewayStableID: "gateway-a")
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.title == "OpenClaw")
        #expect(watchService.lastSent?.params.body == "Meeting with Peter is at 4pm")
        #expect(watchService.lastSent?.params.priority == .timeSensitive)
        #expect(watchService.lastSent?.params.gatewayStableID == "gateway-a")

        let payloadData = try #require(res.payloadJSON?.data(using: .utf8))
        let payload = try JSONDecoder().decode(OpenClawWatchNotifyPayload.self, from: payloadData)
        #expect(payload.deliveredImmediately == false)
        #expect(payload.queuedForDelivery == true)
        #expect(payload.transport == "transferUserInfo")
    }

    @Test @MainActor func `watch reply codec preserves prompt gateway owner`() throws {
        let params = OpenClawWatchNotifyParams(
            title: "Approval",
            body: "Allow?",
            promptId: "prompt-a",
            sessionKey: "ios-a",
            gatewayStableID: "gateway-a")
        let notification = WatchMessagingPayloadCodec.encodeNotificationPayload(
            id: "notification-a",
            params: params)
        #expect(notification["gatewayStableID"] as? String == "gateway-a")

        let reply = try #require(WatchMessagingPayloadCodec.parseQuickReplyPayload([
            "type": OpenClawWatchPayloadType.reply.rawValue,
            "replyId": "reply-a",
            "promptId": "prompt-a",
            "actionId": "approve",
            "gatewayStableID": "gateway-a",
        ], transport: "sendMessage"))
        #expect(reply.gatewayStableID == "gateway-a")
    }

    @Test @MainActor func `watch exec approval codec preserves gateway owner`() throws {
        let approval = OpenClawWatchExecApprovalItem(
            id: "approval-a",
            gatewayStableID: "gateway-a",
            commandText: "echo safe",
            allowedDecisions: [.allowOnce, .deny])
        let prompt = WatchMessagingPayloadCodec.encodeExecApprovalPromptPayload(
            OpenClawWatchExecApprovalPromptMessage(approval: approval))
        let encodedApproval = try #require(prompt["approval"] as? [String: Any])
        #expect(encodedApproval["gatewayStableID"] as? String == "gateway-a")

        let reply = try #require(WatchMessagingPayloadCodec.parseExecApprovalResolvePayload([
            "type": OpenClawWatchPayloadType.execApprovalResolve.rawValue,
            "replyId": "reply-a",
            "approvalId": "approval-a",
            "gatewayStableID": "gateway-a",
            "decision": OpenClawWatchExecApprovalDecision.allowOnce.rawValue,
        ], transport: "sendMessage"))
        #expect(reply.gatewayStableID == "gateway-a")

        let resolved = WatchMessagingPayloadCodec.encodeExecApprovalResolvedPayload(
            OpenClawWatchExecApprovalResolvedMessage(
                approvalId: "approval-a",
                gatewayStableID: "gateway-a"))
        let expired = WatchMessagingPayloadCodec.encodeExecApprovalExpiredPayload(
            OpenClawWatchExecApprovalExpiredMessage(
                approvalId: "approval-a",
                gatewayStableID: "gateway-a",
                reason: .notFound))
        #expect(resolved["gatewayStableID"] as? String == "gateway-a")
        #expect(expired["gatewayStableID"] as? String == "gateway-a")
    }

    @Test @MainActor func `watch application context retains app and approval snapshots`() throws {
        let appPayload = WatchMessagingPayloadCodec.encodeAppSnapshotPayload(
            OpenClawWatchAppSnapshotMessage(
                gatewayStatusText: "Connected",
                gatewayConnected: true,
                agentName: "Main",
                sessionKey: "main",
                gatewayStableID: "gateway-a",
                talkStatusText: "Off",
                talkEnabled: false,
                talkListening: false,
                talkSpeaking: false,
                pendingApprovalCount: 1,
                snapshotId: "app-a"))
        let approvalPayload = WatchMessagingPayloadCodec.encodeExecApprovalSnapshotPayload(
            OpenClawWatchExecApprovalSnapshotMessage(
                approvals: [
                    OpenClawWatchExecApprovalItem(
                        id: "approval-a",
                        gatewayStableID: "gateway-a",
                        commandText: "echo safe",
                        allowedDecisions: [.allowOnce, .deny]),
                ],
                gatewayStableID: "gateway-a",
                snapshotId: "approval-a"))

        let appContext = WatchMessagingPayloadCodec.encodeSnapshotApplicationContext(
            appPayload,
            merging: [:])
        let combined = WatchMessagingPayloadCodec.encodeSnapshotApplicationContext(
            approvalPayload,
            merging: appContext)

        #expect(combined["type"] as? String == OpenClawWatchPayloadType.execApprovalSnapshot.rawValue)
        let nestedApp = try #require(
            combined[OpenClawWatchPayloadType.appSnapshot.rawValue] as? [String: Any])
        let nestedApprovals = try #require(
            combined[OpenClawWatchPayloadType.execApprovalSnapshot.rawValue] as? [String: Any])
        #expect(nestedApp["gatewayStableID"] as? String == "gateway-a")
        #expect(nestedApp["snapshotId"] as? String == "app-a")
        #expect(nestedApprovals["snapshotId"] as? String == "approval-a")
        #expect(nestedApprovals["gatewayStableID"] as? String == "gateway-a")
        #expect((nestedApprovals["approvals"] as? [Any])?.count == 1)
    }

    @Test @MainActor func `handle invoke watch notify rejects empty message`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(title: "   ", body: "\n")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-empty",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .invalidRequest)
        #expect(watchService.lastSent == nil)
    }

    @Test @MainActor func `handle invoke watch notify adds default actions for prompt`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "Task",
            body: "Action needed",
            priority: .passive,
            promptId: "prompt-123")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-default-actions",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.risk == .low)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["done", "snooze_10m", "open_phone", "escalate"])
    }

    @Test @MainActor func `legacy watch reply binds to latest prompt owner`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setConnectedGatewayID("gateway-a")
        let params = OpenClawWatchNotifyParams(
            title: "Task",
            body: "Action needed",
            promptId: "prompt-legacy")
        let paramsJSON = try String(decoding: JSONEncoder().encode(params), as: UTF8.self)
        let request = BridgeInvokeRequest(
            id: "watch-notify-legacy-owner",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)
        #expect(await appModel._test_handleInvoke(request, gatewayStableID: "gateway-a").ok)

        watchService.emitReply(WatchQuickReplyEvent(
            replyId: "legacy-reply",
            promptId: "prompt-legacy",
            actionId: "done",
            actionLabel: "Done",
            sessionKey: nil,
            gatewayStableID: nil,
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel._test_queuedWatchReplyCount() == 1)
    }

    @Test @MainActor func `handle invoke watch notify adds approval defaults`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "Approval",
            body: "Allow command?",
            promptId: "prompt-approval",
            kind: "approval")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-approval-defaults",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["approve", "decline", "open_phone", "escalate"])
        #expect(watchService.lastSent?.params.actions?[1].style == "destructive")
    }

    @Test @MainActor func `handle invoke watch notify derives priority from risk and caps actions`() async throws {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(
            title: "Urgent",
            body: "Check now",
            risk: .high,
            actions: [
                OpenClawWatchAction(id: "a1", label: "A1"),
                OpenClawWatchAction(id: "a2", label: "A2"),
                OpenClawWatchAction(id: "a3", label: "A3"),
                OpenClawWatchAction(id: "a4", label: "A4"),
                OpenClawWatchAction(id: "a5", label: "A5"),
            ])
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-derive-priority",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == true)
        #expect(watchService.lastSent?.params.priority == .timeSensitive)
        #expect(watchService.lastSent?.params.risk == .high)
        let actionIDs = watchService.lastSent?.params.actions?.map(\.id)
        #expect(actionIDs == ["a1", "a2", "a3", "a4"])
    }

    @Test @MainActor func `handle invoke watch notify returns unavailable on delivery failure`() async throws {
        let watchService = MockWatchMessagingService()
        watchService.sendError = NSError(
            domain: "watch",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "WATCH_UNAVAILABLE: no paired Apple Watch"])
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let params = OpenClawWatchNotifyParams(title: "OpenClaw", body: "Delivery check")
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(decoding: paramsData, as: UTF8.self)
        let req = BridgeInvokeRequest(
            id: "watch-notify-fail",
            command: OpenClawWatchCommand.notify.rawValue,
            paramsJSON: paramsJSON)

        let res = await appModel._test_handleInvoke(req)
        #expect(res.ok == false)
        #expect(res.error?.code == .unavailable)
        #expect(res.error?.message.contains("WATCH_UNAVAILABLE") == true)
    }

    @Test @MainActor func `watch reply queues when gateway offline`() async {
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        appModel._test_setConnectedGatewayID("gateway-a")
        watchService.emitReply(
            WatchQuickReplyEvent(
                replyId: "reply-offline-1",
                promptId: "prompt-1",
                actionId: "approve",
                actionLabel: "Approve",
                sessionKey: "ios",
                gatewayStableID: "gateway-a",
                note: nil,
                sentAtMs: 1234,
                transport: "transferUserInfo"))
        await Task.yield()
        #expect(appModel._test_queuedWatchReplyCount() == 1)
    }

    @Test @MainActor func `watch reply queues before cold launch restores its gateway`() {
        let coordinator = WatchReplyCoordinator()
        let event = WatchQuickReplyEvent(
            replyId: "reply-before-route",
            promptId: "prompt-before-route",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "ios",
            gatewayStableID: "gateway-a",
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo")

        let result = coordinator.ingest(
            event,
            isGatewayConnected: false,
            currentGatewayStableID: nil)

        if case .queue = result {
            // Expected.
        } else {
            Issue.record("Expected the reply to wait for route restoration")
        }
        #expect(coordinator.nextQueuedReplyIfConnected(
            true,
            gatewayStableID: "gateway-a")?.replyId == event.replyId)
    }

    @Test @MainActor func `watch approval waits for cold launch route before resolving`() async {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let firstWatchService = MockWatchMessagingService()
        let firstAppModel = NodeAppModel(watchMessagingService: firstWatchService)

        firstWatchService.emitExecApprovalResolve(WatchExecApprovalResolveEvent(
            replyId: "approval-reply-before-route",
            approvalId: "approval-before-route",
            gatewayStableID: "gateway-a",
            decision: .allowOnce,
            sentAtMs: 1234,
            transport: "transferUserInfo"))
        await Task.yield()

        #expect(firstAppModel._test_pendingWatchExecApprovalResolutionCount() == 1)
        #expect(firstWatchService.lastSentExecApprovalSnapshot == nil)
        #expect(firstWatchService.lastSentExecApprovalExpired == nil)

        let restoredWatchService = MockWatchMessagingService()
        let restoredAppModel = NodeAppModel(watchMessagingService: restoredWatchService)
        #expect(restoredAppModel._test_pendingWatchExecApprovalResolutionCount() == 1)
        restoredAppModel._test_setConnectedGatewayID("gateway-a")
        await restoredAppModel._test_flushPendingWatchExecApprovalResolutions()

        #expect(restoredAppModel._test_pendingWatchExecApprovalResolutionCount() == 0)
        #expect(restoredWatchService.lastSentExecApprovalExpired?.gatewayStableID == "gateway-a")
        #expect(restoredWatchService.lastSentExecApprovalExpired?.reason == .unavailable)
        let finalAppModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        #expect(finalAppModel._test_pendingWatchExecApprovalResolutionCount() == 0)
    }

    @Test @MainActor func `legacy watch approval waits for owner binding after cold launch`() async throws {
        NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState()
        defer { NodeAppModel._test_resetPersistedWatchExecApprovalBridgeState() }
        let watchService = MockWatchMessagingService()
        let appModel = NodeAppModel(watchMessagingService: watchService)
        let prompt = NodeAppModel._test_makeExecApprovalPrompt(
            id: "approval-before-route",
            gatewayStableID: "gateway-a",
            commandText: "echo safe",
            allowedDecisions: ["allow-once", "deny"],
            host: nil,
            nodeId: nil,
            agentId: nil,
            expiresAtMs: nil)
        try appModel._test_cacheExecApprovalPromptForWatch(#require(prompt))

        watchService.emitExecApprovalResolve(WatchExecApprovalResolveEvent(
            replyId: "legacy-approval-before-route",
            approvalId: "approval-before-route",
            gatewayStableID: nil,
            decision: .allowOnce,
            sentAtMs: 1234,
            transport: "transferUserInfo"))
        await Task.yield()

        #expect(appModel._test_pendingWatchExecApprovalResolutionCount() == 1)
        let restoredModel = NodeAppModel(watchMessagingService: MockWatchMessagingService())
        #expect(restoredModel._test_pendingWatchExecApprovalResolutionCount() == 1)
    }

    @Test @MainActor func `watch reply dequeue preserves unprocessed events`() {
        let coordinator = WatchReplyCoordinator()
        let first = WatchQuickReplyEvent(
            replyId: "reply-queued-1",
            promptId: "prompt-1",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "ios",
            gatewayStableID: "gateway-a",
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo")
        let second = WatchQuickReplyEvent(
            replyId: "reply-queued-2",
            promptId: "prompt-2",
            actionId: "deny",
            actionLabel: "Deny",
            sessionKey: "ios",
            gatewayStableID: "gateway-a",
            note: nil,
            sentAtMs: 1235,
            transport: "transferUserInfo")
        _ = coordinator.ingest(first, isGatewayConnected: false, currentGatewayStableID: "gateway-a")
        _ = coordinator.ingest(second, isGatewayConnected: false, currentGatewayStableID: "gateway-a")

        #expect(coordinator.nextQueuedReplyIfConnected(
            true,
            gatewayStableID: "gateway-a")?.replyId == first.replyId)
        #expect(coordinator.queuedCount == 1)
        #expect(coordinator.nextQueuedReplyIfConnected(
            true,
            gatewayStableID: "gateway-a")?.replyId == second.replyId)
        #expect(coordinator.queuedCount == 0)
    }

    @Test @MainActor func `watch reply dequeue keeps another gateway queued`() {
        let coordinator = WatchReplyCoordinator()
        let event = WatchQuickReplyEvent(
            replyId: "reply-gateway-a",
            promptId: "prompt-a",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "ios-a",
            gatewayStableID: "gateway-a",
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo")
        _ = coordinator.ingest(event, isGatewayConnected: false, currentGatewayStableID: "gateway-a")

        #expect(coordinator.nextQueuedReplyIfConnected(true, gatewayStableID: "gateway-b") == nil)
        #expect(coordinator.queuedCount == 1)
        #expect(coordinator.nextQueuedReplyIfConnected(
            true,
            gatewayStableID: "gateway-a")?.replyId == event.replyId)
        #expect(coordinator.queuedCount == 0)
    }

    @Test @MainActor func `watch reply rejects a prompt from another gateway`() {
        let coordinator = WatchReplyCoordinator()
        let event = WatchQuickReplyEvent(
            replyId: "reply-gateway-a-on-b",
            promptId: "prompt-a",
            actionId: "approve",
            actionLabel: "Approve",
            sessionKey: "ios-a",
            gatewayStableID: "gateway-a",
            note: nil,
            sentAtMs: 1234,
            transport: "transferUserInfo")

        let result = coordinator.ingest(
            event,
            isGatewayConnected: true,
            currentGatewayStableID: "gateway-b")

        if case .dropMismatchedTarget = result {
            // Expected.
        } else {
            Issue.record("Expected a cross-gateway reply to be rejected")
        }
        #expect(coordinator.queuedCount == 0)
    }

    @Test @MainActor func `handle deep link sets error when not connected`() async throws {
        let appModel = NodeAppModel()
        let url = try #require(URL(string: "openclaw://agent?message=hello"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Gateway not connected") == true)
    }

    @Test @MainActor func `handle deep link rejects oversized message`() async throws {
        let appModel = NodeAppModel()
        let msg = String(repeating: "a", count: 20001)
        let url = try #require(URL(string: "openclaw://agent?message=\(msg)"))
        await appModel.handleDeepLink(url: url)
        #expect(appModel.screen.errorText?.contains("Deep link too large") == true)
    }

    @Test @MainActor func `handle deep link confirms then surfaces missing channel`() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let url = makeAgentDeepLinkURL(message: "hello from deep link")

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt != nil)
        #expect(appModel.openChatRequestID == 0)

        await appModel.approvePendingAgentDeepLinkPrompt()
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 0)
        #expect(appModel.screen.errorText?.contains("Agent request failed") == true)
    }

    @Test @MainActor func `handle deep link coalesces prompt when rate limited`() async throws {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "first prompt"))
        let firstPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        await appModel.handleDeepLink(url: makeAgentDeepLinkURL(message: "second prompt"))
        let coalescedPrompt = try #require(appModel.pendingAgentDeepLinkPrompt)

        #expect(coalescedPrompt.id != firstPrompt.id)
        #expect(coalescedPrompt.messagePreview.contains("second prompt"))
    }

    @Test @MainActor func `handle deep link strips delivery fields when unkeyed`() async throws {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let url = makeAgentDeepLinkURL(
            message: "route this",
            deliver: true,
            to: "123456",
            channel: "telegram")

        await appModel.handleDeepLink(url: url)
        let prompt = try #require(appModel.pendingAgentDeepLinkPrompt)
        #expect(prompt.request.deliver == false)
        #expect(prompt.request.to == nil)
        #expect(prompt.request.channel == nil)
    }

    @Test @MainActor func `handle deep link rejects long unkeyed message when connected`() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let message = String(repeating: "x", count: 241)
        let url = makeAgentDeepLinkURL(message: message)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.screen.errorText?.contains("blocked") == true)
    }

    @Test @MainActor func `handle deep link key bypasses prompt but not transport failure`() async {
        let appModel = NodeAppModel()
        appModel._test_setGatewayConnected(true)
        let key = NodeAppModel._test_currentDeepLinkKey()
        let url = makeAgentDeepLinkURL(message: "trusted request", key: key)

        await appModel.handleDeepLink(url: url)
        #expect(appModel.pendingAgentDeepLinkPrompt == nil)
        #expect(appModel.openChatRequestID == 0)
        #expect(appModel.screen.errorText?.contains("Agent request failed") == true)
    }

    @Test @MainActor func `operator scopes use the active gateway token`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let stableID = "manual|gateway.example.com|443"
        let authenticationOwnerID = stableID
        let config = try GatewayConnectConfig(
            url: #require(URL(string: "wss://127.0.0.1:1")),
            stableID: stableID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: nil,
                deviceAuthGatewayID: authenticationOwnerID))
        appModel.applyGatewayConnectConfig(config)
        let identity = DeviceIdentityStore.loadOrCreate()
        #expect(appModel.hasOperatorAdminScope == false)

        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "operator-token",
            scopes: ["operator.read", "operator.admin", "operator.approvals"],
            gatewayID: authenticationOwnerID)
        appModel._test_refreshOperatorAdminScopeFromStore()
        #expect(appModel.hasOperatorAdminScope == true)
        #expect(appModel._test_shouldRequestStoredOperatorAdminScope(gatewayID: authenticationOwnerID))
        #expect(appModel._test_shouldRequestStoredOperatorApprovalScope(
            gatewayID: authenticationOwnerID,
            forceTalkPermissionUpgradeRequest: true))

        let otherStableID = "manual|other.example.com|443"
        #expect(!appModel._test_shouldRequestStoredOperatorAdminScope(gatewayID: otherStableID))
        #expect(!appModel._test_shouldRequestStoredOperatorApprovalScope(
            gatewayID: otherStableID,
            forceTalkPermissionUpgradeRequest: true))

        DeviceAuthStore.clearToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: authenticationOwnerID)
        appModel._test_refreshOperatorAdminScopeFromStore()
        #expect(appModel.hasOperatorAdminScope == false)
    }

    @Test @MainActor func `send voice transcript throws when gateway offline`() async {
        let appModel = NodeAppModel()
        await #expect(throws: Error.self) {
            try await appModel.sendVoiceTranscript(text: "hello", sessionKey: "main")
        }
    }

    @Test @MainActor func `canvas A 2 UI action dispatches status`() async {
        let appModel = NodeAppModel()
        let body: [String: Any] = [
            "userAction": [
                "name": "tap",
                "id": "action-1",
                "surfaceId": "main",
                "sourceComponentId": "button-1",
                "context": ["value": "ok"],
            ],
        ]
        await appModel._test_handleCanvasA2UIAction(body: body)
        #expect(appModel.screen.urlString.isEmpty)
    }
}
