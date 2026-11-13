import Foundation
import Observation
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI
@testable import OpenClawKit

private actor ChatSendHydrationGateway {
    private struct SentMessage {
        let id: String
        let text: String
        let runID: String
        let sessionKey: String
        let timestamp: Double
    }

    private var holdNextHealth = false
    private var healthReleased = false
    private var heldHealth: (GatewayTestWebSocketTask, String)?
    private var healthEntered: CheckedContinuation<Void, Never>?
    private var messages: [SentMessage] = []
    private let acknowledgesStartedRun: Bool
    private var runCompleted = false
    private var heldRunWaits: [(GatewayTestWebSocketTask, String)] = []
    private var runWaitEntered: CheckedContinuation<Void, Never>?
    private let initialHistory: String?
    private let reportsHistoryIdentity: Bool
    private var holdNextHistory = false
    private var heldHistory: (GatewayTestWebSocketTask, String, [String: Any])?
    private var historyEntered: CheckedContinuation<Void, Never>?

    init(
        acknowledgesStartedRun: Bool = false,
        initialHistory: String? = nil,
        reportsHistoryIdentity: Bool = true)
    {
        self.acknowledgesStartedRun = acknowledgesStartedRun
        self.initialHistory = initialHistory
        self.reportsHistoryIdentity = reportsHistoryIdentity
    }

    func armHistory() {
        self.holdNextHistory = true
    }

    func waitForHeldHistory() async {
        if self.heldHistory != nil { return }
        await withCheckedContinuation { self.historyEntered = $0 }
    }

    func releaseHistory() throws {
        guard let (socket, id, held) = self.heldHistory else { return }
        self.heldHistory = nil
        var payload = held
        payload["messages"] = []
        try self.respond(socket: socket, id: id, payload: payload)
    }

    func armHealth() {
        self.holdNextHealth = true
    }

    func waitForHeldHealth() async {
        if self.heldHealth != nil { return }
        await withCheckedContinuation { self.healthEntered = $0 }
    }

    func releaseHealth() throws {
        self.healthReleased = true
        guard let (socket, id) = self.heldHealth else { return }
        self.heldHealth = nil
        try self.respond(socket: socket, id: id, payload: ["ok": true])
    }

    func sentTexts() -> [String] {
        self.messages.map(\.text)
    }

    func waitForRunObservation() async {
        if !self.heldRunWaits.isEmpty { return }
        await withCheckedContinuation { self.runWaitEntered = $0 }
    }

    func completeRun() throws {
        self.runCompleted = true
        let waits = self.heldRunWaits
        self.heldRunWaits = []
        for (socket, id) in waits {
            try self.respond(socket: socket, id: id, payload: ["status": "completed"])
        }
    }

    func receive(socket: GatewayTestWebSocketTask, message: URLSessionWebSocketTask.Message) throws {
        let data: Data = switch message {
        case let .data(value): value
        case let .string(value): Data(value.utf8)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let method = try XCTUnwrap(frame["method"] as? String)
        if method == "connect" { return }
        let id = try XCTUnwrap(frame["id"] as? String)
        let params = frame["params"] as? [String: Any] ?? [:]
        var payload: [String: Any]
        switch method {
        case "health":
            if self.holdNextHealth {
                self.holdNextHealth = false
                self.heldHealth = (socket, id)
                self.healthEntered?.resume()
                self.healthEntered = nil
                return
            }
            payload = ["ok": self.healthReleased]
        case "chat.history":
            payload = [
                "sessionKey": params["sessionKey"] as? String ?? "main",
                "sessionId": "readiness-session",
                "messages": self.historyMessages(sessionKey: Self.sessionKey(params)),
            ]
            if self.reportsHistoryIdentity {
                payload["sessionInfo"] = [
                    "key": Self.sessionKey(params),
                    "agentId": OpenClawChatSessionKey.agentID(from: Self.sessionKey(params)) ?? "main",
                ]
            }
            if self.acknowledgesStartedRun, let message = self.messages.last {
                var info = payload["sessionInfo"] as? [String: Any] ?? [:]
                info["hasActiveRun"] = !self.runCompleted
                payload["sessionInfo"] = info
                if !self.runCompleted {
                    payload["inFlightRun"] = ["runId": message.runID, "text": ""]
                }
            }
            if self.holdNextHistory {
                self.holdNextHistory = false
                self.heldHistory = (socket, id, payload)
                self.historyEntered?.resume()
                self.historyEntered = nil
                return
            }
        case "chat.send":
            let text = try XCTUnwrap(params["message"] as? String)
            let runID = try XCTUnwrap(params["idempotencyKey"] as? String)
            self.messages.append(SentMessage(
                id: UUID().uuidString, text: text, runID: runID, sessionKey: Self.sessionKey(params),
                timestamp: Date().timeIntervalSince1970 * 1000))
            payload = ["runId": runID, "status": self.acknowledgesStartedRun ? "started" : "ok"]
        case "agent.wait":
            if !self.runCompleted {
                self.heldRunWaits.append((socket, id))
                self.runWaitEntered?.resume()
                self.runWaitEntered = nil
                return
            }
            payload = ["status": "completed"]
        case "sessions.list":
            payload = ["sessions": []]
        case "models.list":
            payload = ["models": []]
        case "config.get":
            payload = ["config": ["session": ["scope": "per-sender", "mainKey": "main"]]]
        case "agents.list":
            payload = ["scope": "per-sender", "mainKey": "main", "defaultId": "main", "agents": []]
        case "question.list":
            payload = ["questions": []]
        default:
            payload = [:]
        }
        try self.respond(socket: socket, id: id, payload: payload)
    }

    private func respond(socket: GatewayTestWebSocketTask, id: String, payload: [String: Any]) throws {
        let frame: [String: Any] = ["type": "res", "id": id, "ok": true, "payload": payload]
        try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: frame)))
    }

    private static func sessionKey(_ params: [String: Any]) -> String {
        let key = params["sessionKey"] as? String ?? "main"
        // The Gateway's default main alias and its explicit agent key are the same conversation.
        return key == "main" ? "agent:\(params["agentId"] as? String ?? "main"):main" : key
    }

    private func historyMessages(sessionKey: String) -> [[String: Any]] {
        guard !self.acknowledgesStartedRun || self.runCompleted else { return [] }
        if let initialHistory, sessionKey == "agent:main:main" {
            return [["role": "assistant", "content": [["type": "text", "text": initialHistory]]]]
        }
        return self.messages.filter { $0.sessionKey == sessionKey }.flatMap { message in
            let user: [String: Any] = [
                "id": message.id,
                "role": "user",
                "content": [["type": "text", "text": message.text]],
                "idempotencyKey": message.runID + ":user",
                "timestamp": message.timestamp,
            ]
            guard self.acknowledgesStartedRun else { return [user] }
            let assistant: [String: Any] = [
                "role": "assistant",
                "content": [["type": "text", "text": "Completed the requested turn"]],
                "timestamp": message.timestamp + 1,
            ]
            return [user, assistant]
        }
    }
}

@MainActor
final class ChatSendHydrationTests: XCTestCase {
    private enum TranscriptTransition: CaseIterable {
        case hydration, differentAgent, differentAccount, differentGateway
        case unknownHistory, unresolvedRouting, rapidSwitch, pendingAttachment
    }

    func testHydrationRetainsOnlyProvenConversationWhileReplacementHistoryWaits() async throws {
        for transition in TranscriptTransition.allCases {
            try await self.checkTranscriptHandoff(transition)
        }
    }

    private func checkTranscriptHandoff(_ transition: TranscriptTransition) async throws {
        let appModel = NodeAppModel()
        let gateway = ChatSendHydrationGateway(
            initialHistory: "Previously accepted answer", reportsHistoryIdentity: transition != .unknownHistory)
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            try await gateway.receive(socket: socket, message: message)
        })
        let session = GatewayTestWebSocketSession(taskFactory: { socket })
        let stableID = "transcript-hydration-\(UUID().uuidString)"
        let url = try XCTUnwrap(URL(string: "ws://transcript-hydration.invalid"))
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = stableID
        func config(stableID: String, token: String = "synthetic-account") -> GatewayConnectConfig {
            GatewayConnectConfig(
                url: url, stableID: stableID, tls: nil, token: token,
                bootstrapToken: nil, password: nil, nodeOptions: options)
        }
        appModel.activeGatewayConnectConfig = config(stableID: stableID)
        let owner = appModel.chatPresentation
        let (cacheGate, releaseCache) = AsyncStream<Void>.makeStream()
        defer {
            releaseCache.finish()
            owner.viewModel?.detachTransport()
            appModel.voiceWake.stop()
        }
        do {
            try await appModel.operatorSession.connect(
                url: url, credentials: .init(), connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {}, onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            owner.sync(appModel: appModel)
            let original = try XCTUnwrap(owner.viewModel)
            // Hold write-through, not history: this handoff cannot be rescued by disk prepaint.
            original.pendingCacheWriteTask = Task { for await _ in cacheGate { break } }
            await original.bootstrapTask?.value
            let store = try XCTUnwrap(original.transcriptCache as? OpenClawChatSQLiteTranscriptCache)
            let cached = await store.loadTranscript(sessionKey: "main")
            XCTAssertTrue(cached.isEmpty)
            XCTAssertEqual(original.messages.flatMap { $0.content.compactMap(\.text) }, ["Previously accepted answer"])
            let rows = original.messages.map(\.id)
            let presentationID = owner.presentationID
            let editor = owner.composerModelResolver()
            original.input = "Still typing"
            if transition == .pendingAttachment {
                original.attachments.append(.init(
                    url: nil, data: Data([1]), fileName: "synthetic.png", mimeType: "image/png", preview: nil))
            }
            if transition == .unresolvedRouting {
                appModel.gatewayDefaultAgentId = "main"
            } else {
                appModel.apply(
                    .connected(.init(serverName: "Fixture", remoteAddress: "fixture")), to: .operator, route: nil)
                await appModel.refreshGatewayOverviewIfConnected()
                XCTAssertEqual(appModel.chatSessionRoutingContract, "per-sender|main|main")
            }
            switch transition {
            case .differentAgent: appModel.selectedAgentId = "research"
            case .differentAccount: appModel.activeGatewayConnectConfig = config(stableID: stableID, token: "other")
            case .differentGateway: appModel.activeGatewayConnectConfig = config(stableID: stableID + "-other")
            default: break
            }
            await gateway.armHistory()
            owner.sync(appModel: appModel)
            if transition == .pendingAttachment {
                XCTAssertTrue(owner.viewModel === original)
                XCTAssertEqual(original.attachments.map(\.fileName), ["synthetic.png"])
                original.removeAttachment(try XCTUnwrap(original.attachments.first?.id))
                owner.sync(appModel: appModel)
            }
            let replacement = try XCTUnwrap(owner.viewModel)
            let replacementBootstrap = replacement.bootstrapTask
            await gateway.waitForHeldHistory()
            XCTAssertTrue(original.isTransportDetached)
            XCTAssertFalse(replacement === original)
            let preserves = transition == .hydration || transition == .rapidSwitch || transition == .pendingAttachment
            XCTAssertEqual(replacement.messages.map(\.id), preserves ? rows : [], "\(transition)")
            XCTAssertFalse(replacement.hasAppliedLiveHistory)
            XCTAssertNil(replacement.historyDeltaCursor)
            XCTAssertEqual(replacement.pendingRunCount, 0)
            if preserves {
                XCTAssertEqual(owner.presentationID, presentationID)
                XCTAssertEqual(replacement.input, "Still typing")
                editor()?.input += " through handoff"
                XCTAssertEqual(replacement.input, "Still typing through handoff")
                XCTAssertEqual(original.input, "Still typing")
            }
            if transition == .rapidSwitch {
                appModel.focusChatSession("agent:main:other")
                owner.sync(appModel: appModel)
                XCTAssertTrue(replacement.messages.isEmpty)
                await replacement.bootstrapTask?.value
            }
            try await gateway.releaseHistory()
            await replacementBootstrap?.value
            XCTAssertTrue(
                replacement.messages.isEmpty,
                "Fresh empty history or a newer destination replaces retained display")
            if transition == .rapidSwitch { XCTAssertEqual(replacement.sessionKey, "agent:main:other") }
            releaseCache.finish()
            await original.pendingCacheWriteTask?.value
            owner.viewModel?.detachTransport()
            await replacement.persistComposerDraft()
            await appModel.operatorSession.disconnect()
            _ = await appModel.purgeChatTranscriptCache(gatewayID: stableID)
            if transition == .differentGateway {
                _ = await appModel.purgeChatTranscriptCache(gatewayID: stableID + "-other")
            }
        } catch {
            try? await gateway.releaseHistory()
            await appModel.operatorSession.disconnect()
            throw error
        }
    }

    private enum Transition: String {
        case unchanged
        case beforeTask
        case pendingHealth
        case startedAcknowledgement
        case differentAccount
        case explicitAgent
        case differentSession

        var permitsSend: Bool {
            switch self {
            case .unchanged, .beforeTask, .pendingHealth, .startedAcknowledgement: true
            case .differentAccount, .explicitAgent, .differentSession: false
            }
        }
    }

    func testDefaultAgentHydrationPreservesAcceptedSend() async throws {
        for transition in [Transition.unchanged, .beforeTask, .pendingHealth] {
            try await self.checkSend(transition)
        }
    }

    func testExplicitRoutingChangesInvalidatePendingSend() async throws {
        for transition in [Transition.differentAccount, .explicitAgent, .differentSession] {
            try await self.checkSend(transition)
        }
    }

    func testStartedRunKeepsOptimisticTurnUntilCompletion() async throws {
        try await self.checkSend(.startedAcknowledgement)
    }

    private func checkSend(_ transition: Transition) async throws {
        let appModel = NodeAppModel()
        let gateway = ChatSendHydrationGateway(acknowledgesStartedRun: transition == .startedAcknowledgement)
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            try await gateway.receive(socket: socket, message: message)
        })
        let socketSession = GatewayTestWebSocketSession(taskFactory: { socket })
        let stableID = "send-hydration-\(UUID().uuidString)"
        let url = try XCTUnwrap(URL(string: "ws://send-hydration.invalid"))
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = stableID
        func config(token: String) -> GatewayConnectConfig {
            GatewayConnectConfig(
                url: url, stableID: stableID, tls: nil, token: token,
                bootstrapToken: nil, password: nil, nodeOptions: options)
        }
        appModel.activeGatewayConnectConfig = config(token: "synthetic-first-account")
        let owner = appModel.chatPresentation
        do {
            try await appModel.operatorSession.connect(
                url: url,
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: socketSession),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            owner.sync(appModel: appModel)
            let original = try XCTUnwrap(owner.viewModel)
            defer { original.detachTransport() }
            await ChatSendHydrationObservation.wait {
                !original.isLoading && original.hasRestoredOutboxMessages
            }
            XCTAssertNil(appModel.chatDeliveryAgentId)
            XCTAssertFalse(original.healthOK)
            let text = "Deliver this accepted send while the default agent resolves"
            let composer = try XCTUnwrap(owner.composerModelResolver()())
            composer.input = text
            XCTAssertTrue(composer.canSend)
            let ownerID = appModel.chatViewModelOwnerID
            let sessionKey = appModel.chatSessionKey
            if transition == .beforeTask {
                try await gateway.releaseHealth()
                let (entered, entry) = AsyncStream<Void>.makeStream()
                defer { entry.finish() }
                withObservationTracking {
                    _ = original.isSubmittingDraft
                } onChange: {
                    entry.yield()
                    entry.finish()
                }
                composer.send()
                // Keep this transition synchronous: the send's scheduled task has not started yet.
                appModel.gatewayDefaultAgentId = "main"
                owner.sync(appModel: appModel)
                var enteredIterator = entered.makeAsyncIterator()
                guard await enteredIterator.next() != nil else {
                    XCTFail("The accepted send never entered submission.")
                    throw CancellationError()
                }
            } else {
                await gateway.armHealth()
                composer.send()
                await gateway.waitForHeldHealth()
                XCTAssertTrue(original.isSending)
                XCTAssertTrue(original.isSubmittingDraft)
                XCTAssertTrue(original.messages.isEmpty)
                let before = await gateway.sentTexts()
                XCTAssertTrue(before.isEmpty)
                switch transition {
                case .unchanged, .beforeTask:
                    break
                case .pendingHealth, .startedAcknowledgement:
                    appModel.gatewayDefaultAgentId = "main"
                case .differentAccount:
                    appModel.gatewayDefaultAgentId = "main"
                    appModel.activeGatewayConnectConfig = config(token: "synthetic-second-account")
                case .explicitAgent:
                    appModel.gatewayDefaultAgentId = "main"
                    appModel.selectedAgentId = "main"
                case .differentSession:
                    appModel.gatewayDefaultAgentId = "main"
                    appModel.focusChatSession("other")
                }
                owner.sync(appModel: appModel)
                try await gateway.releaseHealth()
            }
            XCTAssertEqual(appModel.chatViewModelOwnerID, ownerID)
            XCTAssertEqual(appModel.chatSessionKey, transition == .differentSession ? "other" : sessionKey)
            // Entry was observed above; initial false flags cannot masquerade as task completion.
            await ChatSendHydrationObservation.wait {
                !original.isSending && !original.isSubmittingDraft
            }
            if transition == .startedAcknowledgement {
                XCTAssertEqual(original.pendingRunCount, 1)
                XCTAssertEqual(original.messages.filter { $0.role == "user" }.count, 1)
            }
            if transition == .startedAcknowledgement {
                let pendingModel = try XCTUnwrap(owner.viewModel)
                XCTAssertEqual(pendingModel.pendingRunCount, 1)
                XCTAssertEqual(
                    pendingModel.messages.filter { $0.role == "user" && $0.content.contains { $0.text == text } }.count,
                    1,
                    "A started acknowledgement must retain the submitted turn while canonical history lags.")
                await gateway.waitForRunObservation()
                try await gateway.completeRun()
            }
            // The owner must apply deferred identity itself after accepted send activity settles.
            await ChatSendHydrationObservation.wait {
                guard let current = owner.viewModel, !current.isLoading else { return false }
                return transition == .unchanged || current.activeAgentId == "main"
            }
            let current = try XCTUnwrap(owner.viewModel)
            if transition == .startedAcknowledgement {
                XCTAssertEqual(current.pendingRunCount, 0)
                XCTAssertTrue(current.messages.contains {
                    $0.role == "assistant" && $0.content.contains { $0.text == "Completed the requested turn" }
                })
            }
            let sent = await gateway.sentTexts()
            let userRows = current.messages.filter { message in
                message.role == "user" && message.content.contains { $0.text == text }
            }
            XCTAssertEqual(sent, transition.permitsSend ? [text] : [], transition.rawValue)
            XCTAssertEqual(userRows.count, transition.permitsSend ? 1 : 0, transition.rawValue)
            XCTAssertEqual(current.input, transition == .explicitAgent ? text : "", transition.rawValue)
            owner.viewModel?.detachTransport()
            await appModel.operatorSession.disconnect()
        } catch {
            try? await gateway.releaseHealth()
            try? await gateway.completeRun()
            owner.viewModel?.detachTransport()
            await appModel.operatorSession.disconnect()
            throw error
        }
    }
}

@MainActor
private final class ChatSendHydrationObservation {
    private let condition: @MainActor () -> Bool
    private var continuation: CheckedContinuation<Void, Never>?

    private init(condition: @escaping @MainActor () -> Bool) {
        self.condition = condition
    }

    static func wait(until condition: @escaping @MainActor () -> Bool) async {
        let observation = ChatSendHydrationObservation(condition: condition)
        await withCheckedContinuation { continuation in
            observation.continuation = continuation
            observation.observe()
        }
        withExtendedLifetime(observation) {}
    }

    private func observe() {
        guard self.continuation != nil else { return }
        if self.condition() {
            let continuation = self.continuation
            self.continuation = nil
            continuation?.resume()
            return
        }
        withObservationTracking {
            _ = self.condition()
        } onChange: { [weak self] in
            Task { @MainActor in self?.observe() }
        }
    }
}
