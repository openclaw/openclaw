import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
import UIKit
@testable import OpenClaw
@testable import OpenClawChatUI

/// Local Gateway answers for chat replay and the alive beacon. Runs on the fixture's queue.
private final class WakeChatGateway: @unchecked Sendable {
    private let lock = NSLock()
    private var healthy = true
    private var sends: [(key: String, text: String)] = []

    var sentKeys: [String] {
        self.lock.withLock { self.sends.map(\.key) }
    }

    func setHealthy(_ healthy: Bool) {
        self.lock.withLock { self.healthy = healthy }
    }

    func handle(method: String, params: [String: Any]) -> [String: Any]? {
        switch method {
        case "health":
            return ["ok": self.lock.withLock { self.healthy }]
        case "node.event":
            return ["ok": true, "handled": true]
        case "agents.list":
            return ["defaultId": "main", "mainKey": "main", "scope": "per-sender", "agents": [["id": "main"]]]
        case "sessions.list":
            return ["sessions": []]
        case "chat.send":
            let key = params["idempotencyKey"] as? String ?? ""
            self.lock.withLock { self.sends.append((key, params["message"] as? String ?? "")) }
            return ["runId": key, "status": "started"]
        case "chat.history":
            let rows: [[String: Any]] = self.lock.withLock {
                self.sends.map { send in
                    [
                        "id": "history-\(send.key)",
                        "role": "user",
                        "content": [["type": "text", "text": send.text]],
                        "idempotencyKey": "\(send.key):user",
                    ]
                }
            }
            return ["sessionKey": params["sessionKey"] as? String ?? "agent:main:main", "messages": rows]
        default:
            return nil
        }
    }
}

@MainActor
@Suite(.serialized)
struct BackgroundWakeChatOutboxTests {
    private static let lastSuccessKey = "gateway.backgroundAlive.lastSuccessAtMs"

    @Test(arguments: [true, false])
    func `throttled silent push reports new data only when it delivered chat`(queuesMessage: Bool) async throws {
        let isolation = await GatewayRegistryTestIsolation()
        defer { isolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "wake-chat-\(UUID().uuidString)")
        defer { state.restore() }
        let defaults = UserDefaults.standard
        let previousSuccess = defaults.object(forKey: Self.lastSuccessKey)
        defer {
            if let previousSuccess {
                defaults.set(previousSuccess, forKey: Self.lastSuccessKey)
            } else {
                defaults.removeObject(forKey: Self.lastSuccessKey)
            }
        }

        let server = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [], tls: true)
        defer { server.stop() }
        let gateway = WakeChatGateway()
        server.acceptedOperatorScopes = ["operator.read", "operator.write"]
        server.helloCapabilities = ["chat-send-routing-contract", "session-settings-cas-v1"]
        server.requestHandler = { _, method, params in gateway.handle(method: method, params: params) }
        let stableID = "manual|127.0.0.1|\(server.port)"
        var options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "Wake chat",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false)
        options.deviceAuthGatewayID = stableID
        let tls = GatewayTLSParams(
            required: true,
            expectedFingerprint: server.fingerprint,
            allowTOFU: false,
            storeKey: nil)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        appModel.applyGatewayConnectConfig(GatewayConnectConfig(
            url: server.url(),
            stableID: stableID,
            tls: tls,
            token: "wake-chat-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options))
        try await Self.wait {
            appModel.gatewayConnected && appModel.isOperatorGatewayConnected && appModel.chatDeliveryAgentId != nil
        }
        appModel.chatPresentation.sync(appModel: appModel)
        let viewModel = try #require(appModel.chatPresentation.viewModel)
        defer { viewModel.detachTransport() }
        try await Self.wait { viewModel.healthOK }
        let store = try #require(appModel.makeChatOfflineStore())

        // Connected sockets, but Chat sees the Gateway as unhealthy, so a send is queued.
        gateway.setHealthy(false)
        await viewModel.pollHealthIfNeeded(force: true)
        #expect(!viewModel.healthOK)
        if queuesMessage {
            viewModel.input = "queued while unhealthy"
            viewModel.send()
            try await Self.wait { await !store.loadCommands().isEmpty }
        }
        gateway.setHealthy(true)

        // Throttled wake: node connected and a beacon succeeded moments ago.
        appModel.isBackgrounded = true
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: Self.lastSuccessKey)
        let delegate = OpenClawAppDelegate()
        delegate.appModel = appModel
        let result = await withCheckedContinuation { continuation in
            delegate.application(
                UIApplication.shared,
                didReceiveRemoteNotification: ["aps": ["content-available": 1]],
                fetchCompletionHandler: { continuation.resume(returning: $0) })
        }

        #expect(result == (queuesMessage ? .newData : .noData))
        #expect(gateway.sentKeys.count == (queuesMessage ? 1 : 0))
        #expect(await store.loadCommands().filter { $0.status == .queued }.isEmpty)
        _ = await appModel.purgeChatTranscriptCache(gatewayID: stableID)
    }

    @Test func `wake that cannot reach the gateway does not wait for queued chat sends`() async throws {
        let appModel = NodeAppModel()
        let gatewayID = "bg-outbox-unreachable-\(UUID().uuidString)"
        appModel.connectedGatewayID = gatewayID
        let store = try #require(appModel.makeChatOfflineStore())
        appModel.chatPresentation.sync(appModel: appModel)
        let viewModel = try #require(appModel.chatPresentation.viewModel)
        defer { viewModel.detachTransport() }
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: UUID().uuidString,
            sessionKey: "main",
            deliverySessionKey: "agent:main:main",
            routingContract: "per-sender|main|main",
            agentID: "main",
            text: "queued while offline",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        appModel.isBackgrounded = true
        #expect(!appModel.gatewayConnected)

        let started = Date()
        _ = await appModel.handleBackgroundRefreshWake()

        #expect(Date().timeIntervalSince(started) < 2)
        #expect(await store.loadCommands().map(\.status) == [.queued])
        _ = await appModel.purgeChatTranscriptCache(gatewayID: gatewayID)
    }

    private static func wait(_ condition: @MainActor () async -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while await !condition() {
            guard Date() < deadline else {
                Issue.record("timed out")
                throw CancellationError()
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}

extension BackgroundWakeChatOutboxTests {
    @Test(.timeLimit(.minutes(1)))
    func `background drain bounds health reconnect after a sending socket is lost`() async throws {
        let answers = WakeChatGateway()
        let disconnected = AsyncTestGate()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let request = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(request["id"] as? String)
                let method = try #require(request["method"] as? String)
                let params = request["params"] as? [String: Any] ?? [:]
                if method == "chat.send" {
                    _ = answers.handle(method: method, params: params)
                    return // Accepted by the socket, but no ACK or canonical history.
                }
                let payload: [String: Any]? = method == "chat.history"
                    ? ["sessionKey": params["sessionKey"] as? String ?? "agent:main:main", "messages": []]
                    : answers.handle(method: method, params: params)
                let response: [String: Any] = if let payload {
                    ["type": "res", "id": id, "ok": true, "payload": payload]
                } else {
                    [
                        "type": "res",
                        "id": id,
                        "ok": false,
                        "error": ["code": "INVALID_REQUEST", "message": "unknown method: \(method)"],
                    ]
                }
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: response)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: ["agents.list", "sessions.list", "chat.history", "chat.send", "health"],
                    capabilities: ["chat-send-routing-contract", "session-settings-cas-v1"],
                    scopes: ["operator.read", "operator.write"]))
            })
        })
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("wake-reconnect-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? databases.close() }
        let gatewayID = "wake-reconnect-\(UUID().uuidString)"
        defer { UserDefaults.standard.removePersistentDomain(forName: gatewayID) }
        let store = databases.store(gatewayID: gatewayID)
        let gateway = GatewayNodeSession()
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = gatewayID
        let viewModel = try OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(
                gateway: gateway, globalAgentId: "main", outboxGatewayID: gatewayID),
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            transcriptCache: store,
            outbox: store,
            modelPickerStore: ChatModelPickerStore(
                defaults: #require(UserDefaults(suiteName: gatewayID))))
        defer { viewModel.detachTransport() }
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://wake-reconnect-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: socketSession),
                onConnected: {},
                onDisconnected: { _ in disconnected.open() },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            viewModel.load()
            try await Self.wait { viewModel.healthOK && viewModel.hasCurrentSessionMetadata }
            answers.setHealthy(false)
            await viewModel.pollHealthIfNeeded(force: true)
            #expect(!viewModel.healthOK)
            viewModel.input = "retain this ambiguous send"
            viewModel.send()
            try await Self.wait { await store.loadCommands().map(\.status) == [.queued] }
            let queuedID = try #require(await store.loadCommands().first?.id)
            answers.setHealthy(true)
            await viewModel.pollHealthIfNeeded(force: true)
            try await Self.wait {
                let statuses = await store.loadCommands().map(\.status)
                return answers.sentKeys == [queuedID] && statuses == [.sending]
            }
            #expect(viewModel.healthOK)
            let socket = try #require(socketSession.latestTask())
            let started = Date()
            // Observe a live route, then lose the sending socket before the first health probe.
            let result = await viewModel.drainOutboxForBackgroundWake(timeoutMs: 200) { _ in
                guard await gateway.currentRoute(ifGatewayID: gatewayID) != nil else { return false }
                socket.emitReceiveFailure()
                await disconnected.wait()
                do {
                    try await Self.wait { !viewModel.healthOK }
                } catch {
                    return false
                }
                return true
            }
            #expect(Date().timeIntervalSince(started) < 0.4)
            #expect(result == .pending || result == .failed)
            let row = try #require(await store.loadCommands().first)
            #expect(row.id == queuedID && row.status == .failed && row.retryCount == 0)
            #expect(row.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
            #expect(answers.sentKeys == [queuedID])

            // The channel still reconnects normally; probing does not replay an ambiguous send.
            try await Self.wait { await gateway.currentRoute(ifGatewayID: gatewayID) != nil }
            await viewModel.pollHealthIfNeeded(force: true)
            #expect(viewModel.healthOK)
            #expect(answers.sentKeys == [queuedID])
            await gateway.disconnect()
        } catch {
            await gateway.disconnect()
            throw error
        }
    }
}
