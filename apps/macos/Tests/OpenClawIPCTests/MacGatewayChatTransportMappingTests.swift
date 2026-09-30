import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct MacGatewayChatTransportMappingTests {
    private actor RequestRecorder {
        var payloads: [Data] = []

        func append(_ data: Data) {
            self.payloads.append(data)
        }

        func snapshot() -> [Data] {
            self.payloads
        }
    }

    @Test(arguments: [false, true, nil] as [Bool?])
    func `progress requests negotiate owner scope on the connected server`(supportsOwner: Bool?) async throws {
        let recorder = RequestRecorder()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                var payload = "{}"
                if frame["method"] as? String == "progressCard.get" {
                    let params = try #require(frame["params"] as? [String: Any])
                    try await recorder.append(JSONSerialization.data(withJSONObject: params))
                    // A released server's closed schema rejects the extra owner field.
                    #expect(supportsOwner == true || params["agentId"] == nil)
                    let owner = params["agentId"] as? String ??
                        OpenClawChatSessionKey.agentID(from: params["sessionKey"] as? String) ?? "main"
                    payload = #"{"card":{"sessionKey":"agent:\#(owner):global","revision":1,"updatedAt":10,"markdown":"\#(owner)","steps":[]}}"#
                }
                socket
                    .emitReceiveSuccess(.data(Data(#"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#
                            .utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let hello = GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: ["progressCard.get"],
                    capabilities: supportsOwner == true ? ["progress-card-agent-scope-v1"] : [])
                guard supportsOwner == nil else { return .data(hello) }
                var frame = try #require(JSONSerialization.jsonObject(with: hello) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var features = try #require(payload["features"] as? [String: Any])
                features.removeValue(forKey: "capabilities")
                payload["features"] = features
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: socketSession))
        do {
            _ = try await gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
            let ordinary = try await transport.fetchProgressCard(
                sessionKey: "agent:research:global",
                agentID: "research")
            #expect(ordinary?.markdown == "research")
            if supportsOwner == true {
                let global = try await transport.fetchProgressCard(sessionKey: "global", agentID: "research")
                #expect(global?.markdown == "research")
            } else {
                do {
                    _ = try await transport.fetchProgressCard(sessionKey: "global", agentID: "research")
                    Issue.record("Unadvertised owner-scoped progress must not dispatch")
                } catch let error as NSError {
                    #expect(error.localizedDescription == OpenClawChatTransportUpgradeMessage.progressCardAgentScope)
                }
            }
            let params = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: String])
            }
            #expect(params == (supportsOwner == true ? [
                ["sessionKey": "agent:research:global"],
                ["sessionKey": "global", "agentId": "research"],
            ] : [["sessionKey": "agent:research:global"]]))
            await gateway.shutdown()
        } catch {
            await gateway.shutdown()
            throw error
        }
    }

    private func withSessionTransport(
        connectInitially: Bool = true,
        mainSessionKey: String? = nil,
        capabilities: [String] = ["session-unread-ack-contract"],
        _ run: @MainActor (MacGatewayChatTransport, RequestRecorder) async throws -> Void) async throws
    {
        let recorder = RequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                let method = try #require(GatewayWebSocketTestSupport.requestMethod(from: message))
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                if method != "health" {
                    await recorder.append(data)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let params = frame["params"] as? [String: Any]
                let payload = switch method {
                case "agents.list": GatewayWebSocketTestSupport.agentCatalogPayload
                case "agent.identity.get":
                    try String(decoding: JSONEncoder().encode(AgentIdentityResult(
                        agentid: #require(params?["agentId"] as? String),
                        name: "Assistant", namesource: "default", avatar: "A")), as: UTF8.self)
                case "sessions.patch":
                    params?["agentId"] as? String == "agent-a"
                        ? #"{"key":"global","entry":{"sessionId":"global-a","pinnedAt":10,"updatedAt":11}}"#
                        : #"{"key":"global","entry":{"sessionId":"global-b","color":null,"updatedAt":12}}"#
                case "sessions.rewind": #"{"editorText":"rewound draft"}"#
                case "sessions.fork": #"{"sessionKey":"forked","editorText":"continued draft"}"#
                case "sessions.list":
                    #"{"defaults":{"modelProvider":"example","model":"model-a","contextTokens":128000,"thinkingOptions":["low","high"],"thinkingDefault":"low","modelSelectionTarget":"session","agentRuntime":{"id":"pi","source":"agent"}},"sessions":[]}"#
                case "chat.send": #"{"runId":"native-send","status":"ok"}"#
                default: #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    mainSessionKey: mainSessionKey,
                    methods: [
                        "agents.list", "agent.identity.get", "sessions.patch", "sessions.delete", "sessions.rewind",
                        "sessions.fork", "sessions.list",
                    ],
                    capabilities: capabilities))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        do {
            if connectInitially {
                _ = try await gateway.request(method: "health", params: nil)
            }
            let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "agent-a")
            try await run(transport, recorder)
            await gateway.shutdown()
        } catch {
            await gateway.shutdown()
            throw error
        }
    }

    @Test func `all native conversation send paths retain the web ownership fence`() async throws {
        try await self.withSessionTransport(capabilities: [GatewayServerCapability.chatSendRoutingContract.rawValue]) {
            base, recorder in
            let transport = MacGatewayChatTransport(connection: base.connection, outboxGatewayID: "fixture")
            let sessionKey = "agent:main:main"
            let ownership = transport.connection.chatSendOwnership
            let scope = await transport.connection.conversationOwnershipScope(sessionKey: sessionKey, agentID: nil)
            let webOwner = UUID()
            guard case let .available(lease) = await transport.acquireOutboxRouteLease() else {
                Issue.record("Expected an outbox route lease")
                return
            }
            let sends: [@Sendable () async throws -> OpenClawChatSendResponse] = [
                {
                    try await transport.sendMessage(
                        sessionKey: sessionKey, message: "direct", thinking: "off",
                        idempotencyKey: "direct", attachments: [])
                },
                {
                    try await transport.sendMessage(
                        sessionKey: sessionKey, agentID: nil,
                        expectedSessionRoutingContract: lease.sessionRoutingContract,
                        message: "targeted", thinking: "off", idempotencyKey: "targeted", attachments: [])
                },
                {
                    try await lease.sendMessage(
                        sessionKey: sessionKey, message: "outbox", thinking: "off",
                        idempotencyKey: "outbox", attachments: [])
                },
            ]
            for send in sends {
                try #require(ownership.beginWeb(scope, owner: webOwner))
                await #expect(throws: OpenClawChatSendOwnershipError.self) { try await send() }
                ownership.endWeb(scope, owner: webOwner)
                #expect(try await send().status == "ok")
                // Completion releases the native claim so a subsequent renderer handoff can proceed.
                #expect(ownership.beginWeb(scope, owner: webOwner))
                ownership.endWeb(scope, owner: webOwner)
            }
            let requests = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            #expect(requests.filter { $0["method"] as? String == "chat.send" }.count == 3)
        }
    }

    @Test func `new session rosters preserve selectable choices on their captured connection`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let expected = OpenClawChatAgentsListResponse(
                defaultId: "system",
                agents: [
                    OpenClawChatAgentChoice(id: "zeta", name: " Zeta ", emoji: "A", workspaceGit: true),
                    OpenClawChatAgentChoice(id: "legacy", name: "Assistant", emoji: "A"),
                    OpenClawChatAgentChoice(id: "alpha", name: "Assistant", emoji: "A", workspaceGit: false),
                ],
                sessionRoutingContract: "per-sender|main|system")
            var catalog: OpenClawChatAgentsListResponse?
            try await transport.loadAgents { catalog = $0 }
            #expect(catalog == expected)
            let lease = try #require(await transport.acquireNewSessionRouteLease())
            try await lease.loadAgents { catalog = $0 }
            #expect(catalog == expected)
            await transport.connection.shutdown()
            await #expect(throws: Error.self) {
                try await lease.loadAgents { _ in Issue.record("Retired roster published") }
            }
            let frames = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            let batch = ["agents.list"] + Array(repeating: "agent.identity.get", count: 3)
            #expect(frames.map { $0["method"] as? String } == batch + batch)
            let identityRequests = frames.filter { $0["method"] as? String == "agent.identity.get" }
            #expect(identityRequests.compactMap { ($0["params"] as? [String: Any])?["agentId"] as? String }.sorted() ==
                ["alpha", "alpha", "legacy", "legacy", "zeta", "zeta"])
        }
    }

    @Test func `catalog loading connects before acquiring its identity lease`() async throws {
        try await self.withSessionTransport(connectInitially: false) { transport, _ in
            var catalog: OpenClawChatAgentsListResponse?
            try await transport.loadAgents { catalog = $0 }
            #expect(catalog?.agents.map(\.displayName) == ["Zeta", "Assistant", "Assistant"])
        }
    }

    @Test func `mutation lease resolves the current global agent for each request`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let lease = try #require(await transport.acquireSessionMutationRouteLease())
            let firstReceipt = try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                pinned: true,
                archived: nil,
                unread: nil)
            let observerTransport = transport
            observerTransport.updateDefaultGlobalAgentID(" Agent-B ")
            let secondReceipt = try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                color: .some(nil),
                pinned: nil,
                archived: nil,
                unread: nil)
            #expect(firstReceipt != nil)
            #expect(secondReceipt != nil)
            try await lease.deleteSession(key: "agent:agent-b:work")

            let frames = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            let methods = frames.map { $0["method"] as? String }
            try #require(methods == ["sessions.patch", "sessions.patch", "sessions.delete"])
            let params = try frames.map { try #require($0["params"] as? [String: Any]) }
            #expect(params[0]["key"] as? String == "global")
            #expect(params[0]["agentId"] as? String == "agent-a")
            #expect(params[1]["key"] as? String == "global")
            #expect(params[1]["agentId"] as? String == "agent-b")
            #expect(params[1]["color"] is NSNull)
            #expect(params[2]["key"] as? String == "agent:agent-b:work")
            #expect(params[2]["agentId"] == nil)
            #expect(params[2]["deleteTranscript"] as? Bool == true)
        }
    }

    @Test func `mac chat advertises typed agent rosters and inline widgets`() {
        #expect(GatewayConnection.operatorClientCaps == [
            OpenClawGatewayClientCapability.agentKind,
            OpenClawGatewayClientCapability.inlineWidgets,
            OpenClawGatewayClientCapability.modelSelectionPolicy,
            OpenClawGatewayClientCapability.usageRefreshing,
        ])
    }

    @Test func `bare global session target carries normalized selected agent`() {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: "  Agent-A  ")

        #expect(transport.sessionTarget(for: " GLOBAL ") == .init(
            sessionKey: "GLOBAL",
            agentID: "agent-a"))
        #expect(transport.sessionTarget(for: "agent:agent-a:main") == .init(
            sessionKey: "agent:agent-a:main",
            agentID: nil))
        #expect(transport.sessionTarget(for: "main") == .init(
            sessionKey: "main",
            agentID: nil))

        let snapshotObserverTransport = transport
        snapshotObserverTransport.updateDefaultGlobalAgentID("Agent-B")
        #expect(transport.sessionTarget(for: "global") == .init(
            sessionKey: "global",
            agentID: "agent-b"))
    }

    @Test func `bare global session target tolerates missing selected agent`() {
        let transport = MacGatewayChatTransport()

        #expect(transport.sessionTarget(for: "global") == .init(
            sessionKey: "global",
            agentID: nil))
    }

    @Test func `session list request follows the current routing agent`() {
        let transport = MacGatewayChatTransport(defaultGlobalAgentID: "  Agent-A  ")

        let first = transport.sessionsListRequest(limit: 50, search: nil, archived: false)
        #expect(first.params["agentId"]?.value as? String == "agent-a")

        transport.updateDefaultGlobalAgentID("Agent-B")
        let second = transport.sessionsListRequest(limit: nil, search: "recent", archived: true)
        #expect(second.params["agentId"]?.value as? String == "agent-b")

        let selected = transport.sessionsListRequest(
            limit: 50, search: "older", archived: true, agentID: "research")
        #expect(selected.params["agentId"]?.value as? String == "research")
        #expect(transport.sessionTarget(for: "global").agentID == "agent-b")

        let unowned = MacGatewayChatTransport()
            .sessionsListRequest(limit: nil, search: nil, archived: false)
        #expect(unowned.params["agentId"] == nil)
    }

    @Test func `session list preserves model scope and runtime while supplying the main key`() async throws {
        try await self.withSessionTransport(mainSessionKey: "agent:agent-a:main") { transport, _ in
            let response = try await transport.listSessions(limit: 50, search: nil, archived: false)
            let defaults = try #require(response.defaults)
            #expect(defaults.modelSelectionTarget == "session")
            #expect(defaults.agentRuntime?.id == "pi")
            #expect(defaults.agentRuntime?.source == "agent")
            #expect(defaults.modelProvider == "example")
            #expect(defaults.model == "model-a")
            #expect(defaults.contextTokens == 128_000)
            #expect(defaults.thinkingOptions == ["low", "high"])
            #expect(defaults.thinkingDefault == "low")
            #expect(defaults.mainSessionKey == "agent:agent-a:main")
        }
    }

    @Test func `scoped global routes and captured mutations ignore later default changes`() async throws {
        let base = MacGatewayChatTransport(defaultGlobalAgentID: "main")
        let selected = try #require(base.scoped(toAgentID: "research") as? MacGatewayChatTransport)
        let recorder = RequestRecorder()
        let lease = OpenClawChatSessionMutationRouteLease(
            sessionTarget: { base.sessionTarget(for: $0) },
            unreadAckContract: true,
            request: { request in
                let params = request.params.mapValues(\.value)
                try await recorder.append(JSONSerialization.data(withJSONObject: params))
                return Data("{}".utf8)
            })

        base.updateDefaultGlobalAgentID("replacement")
        #expect(selected.sessionTarget(for: "global") == .init(sessionKey: "global", agentID: "research"))
        #expect(selected.sessionTarget(for: "main") == .init(sessionKey: "main", agentID: "research"))
        #expect(selected.sessionTarget(for: "custom") == .init(sessionKey: "custom", agentID: "research"))
        #expect(selected.sessionTarget(for: "agent:research:global") == .init(
            sessionKey: "agent:research:global", agentID: nil))
        try await lease.patchSession(
            key: "global", agentID: "research", label: "Research notes", category: nil,
            pinned: true, archived: nil, unread: nil)
        try await lease.deleteSession(key: "global", agentID: "research")

        let requests = try await recorder.snapshot().map {
            try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
        }
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0["key"] as? String == "global" })
        #expect(requests.allSatisfy { $0["agentId"] as? String == "research" })
    }

    @Test func `fixed connection does not inherit app wide cache routing`() async throws {
        let url = try #require(URL(string: "wss://fixed.example"))
        let connection = GatewayConnection(configProvider: {
            (url: url, token: nil, password: nil)
        })
        let transport = MacGatewayChatTransport(
            connection: connection,
            outboxGatewayID: "manual-fixed")

        #expect(await transport.currentOutboxGatewayMatchesConnection())
        await connection.shutdown()
    }

    @Test func `session settings request preserves verbosity patch`() {
        let request = MacGatewayChatTransport.sessionSettingsRequest(
            sessionKey: "global",
            agentID: "reviewer",
            patch: OpenClawChatSessionSettingsPatch(
                model: .some("openai/gpt-5.6-luna"),
                thinkingLevel: .some(nil),
                fastMode: .some(.on),
                verboseLevel: .some("full")))

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["model"]?.value as? String == "openai/gpt-5.6-luna")
        #expect(request.params["thinkingLevel"]?.value is NSNull)
        #expect(request.params["fastMode"]?.value as? Bool == true)
        #expect(request.params["verboseLevel"]?.value as? String == "full")
    }

    @Test func `scoped settings mutations keep the fixed owner for bare keys`() async throws {
        let recorder = RequestRecorder()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                var payload = "{}"
                if GatewayWebSocketTestSupport.requestMethod(from: message) == "sessions.patch" {
                    let data: Data = switch message {
                    case let .data(value): value
                    case let .string(value): Data(value.utf8)
                    @unknown default: throw URLError(.cannotParseResponse)
                    }
                    let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                    let params = try #require(frame["params"] as? [String: Any])
                    try await recorder.append(JSONSerialization.data(withJSONObject: params))
                    payload = #"{"entry":{}}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect", methods: ["sessions.patch"]))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: socketSession))
        do {
            _ = try await gateway.request(method: "health", params: nil)
            let base = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "main")
            let scoped = try #require(base.scoped(toAgentID: "research") as? MacGatewayChatTransport)
            base.updateDefaultGlobalAgentID("replacement")
            for key in ["main", "custom", "agent:other:main"] {
                _ = try await scoped.patchSessionSettings(
                    sessionKey: key, agentID: nil, patch: .init(verboseLevel: .some("full")))
            }
            let requests = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            #expect(requests.map { $0["key"] as? String } == ["main", "custom", "agent:other:main"])
            #expect(requests.map { $0["agentId"] as? String } == ["research", "research", nil])
            await gateway.shutdown()
        } catch {
            await gateway.shutdown()
            throw error
        }
    }

    @Test func `full message request uses generated gateway field names`() throws {
        let request = try MacGatewayChatTransport.fullMessageRequest(
            sessionKey: "global",
            agentID: "reviewer",
            messageID: "msg-42")

        #expect(request.method == "chat.message.get")
        #expect(request.params["sessionKey"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["messageId"]?.value as? String == "msg-42")
        #expect(request.params["maxChars"]?.value as? Int == 500_000)
    }

    @Test func `message rewind and fork dispatch resolved session targets`() async throws {
        try await self.withSessionTransport { transport, recorder in
            transport.updateDefaultGlobalAgentID(" Reviewer ")
            let rewind = try await transport.rewindSession(sessionKey: "global", entryId: " msg-42 ")
            let fork = try await transport.forkSessionAtMessage(sessionKey: "agent:reviewer:main", entryId: "msg-43")

            #expect(rewind.editorText == "rewound draft")
            #expect(fork.sessionKey == "forked")
            #expect(fork.editorText == "continued draft")
            let frames = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            #expect(frames.map { $0["method"] as? String } == ["sessions.rewind", "sessions.fork"])
            #expect(frames.map { $0["params"] as? [String: String] } == [
                ["sessionKey": "global", "agentId": "reviewer", "entryId": "msg-42"],
                ["sessionKey": "agent:reviewer:main", "entryId": "msg-43"],
            ])
        }
    }

    @Test func `legacy trace preference migrates to independent defaults once`() throws {
        let suiteName = "MacGatewayChatTransportMappingTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(false, forKey: OpenClawChatWindowShell.assistantTraceDefaultsKey)

        #expect(WebChatTracePreferences.displayOptions(defaults: defaults).isEmpty)
        #expect(defaults.object(forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey) as? Bool == false)
        #expect(defaults.object(forKey: OpenClawChatWindowShell.assistantToolActivityDefaultsKey) as? Bool == false)

        defaults.set(true, forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey)
        #expect(WebChatTracePreferences.displayOptions(defaults: defaults) == [.reasoning])
    }

    @Test func `snapshot maps to health`() {
        let snapshot = Snapshot(
            presence: [],
            health: ["ok": OpenClawProtocol.AnyCodable(false)],
            stateversion: StateVersion(presence: 1, health: 1),
            uptimems: 123,
            configpath: nil,
            statedir: nil,
            sessiondefaults: nil,
            authmode: nil,
            updateavailable: nil)

        let hello = HelloOk(
            type: "hello",
            _protocol: 2,
            server: [:],
            features: [:],
            snapshot: snapshot,
            controluitabs: nil,
            pluginsurfaceurls: nil,
            auth: [:],
            policy: [:])

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.snapshot(hello))
        switch mapped {
        case let .health(ok):
            #expect(ok == false)
        default:
            Issue.record("expected .health from snapshot, got \(String(describing: mapped))")
        }
    }

    @Test func `health event maps to health`() {
        let frame = EventFrame(
            type: "event",
            event: "health",
            payload: OpenClawProtocol.AnyCodable(["ok": OpenClawProtocol.AnyCodable(true)]),
            seq: 1,
            stateversion: nil)

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        switch mapped {
        case let .health(ok):
            #expect(ok == true)
        default:
            Issue.record("expected .health from health event, got \(String(describing: mapped))")
        }
    }

    @Test func `tick event maps to tick`() {
        let frame = EventFrame(type: "event", event: "tick", payload: nil, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect({
            if case .tick = mapped {
                return true
            }
            return false
        }())
    }

    @Test func `sessions changed event maps to authoritative refresh signal`() {
        let payload = OpenClawProtocol.AnyCodable([
            "sessionKey": OpenClawProtocol.AnyCodable("agent:main:main"),
            "agentId": OpenClawProtocol.AnyCodable("main"),
            "reason": OpenClawProtocol.AnyCodable("command-metadata"),
        ])
        let frame = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: payload,
            seq: 1,
            stateversion: nil)

        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        guard case let .sessionsChanged(change) = mapped else {
            Issue.record("expected .sessionsChanged, got \(String(describing: mapped))")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))
    }

    @Test func `chat event maps to chat`() {
        let payload = OpenClawProtocol.AnyCodable([
            "runId": OpenClawProtocol.AnyCodable("run-1"),
            "sessionKey": OpenClawProtocol.AnyCodable("main"),
            "state": OpenClawProtocol.AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func `session message event maps to session message`() {
        let payload = OpenClawProtocol.AnyCodable([
            "sessionKey": OpenClawProtocol.AnyCodable("agent:main:main"),
            "messageId": OpenClawProtocol.AnyCodable("msg-1"),
            "messageSeq": OpenClawProtocol.AnyCodable(7),
            "message": OpenClawProtocol.AnyCodable([
                "role": OpenClawProtocol.AnyCodable("user"),
                "content": OpenClawProtocol.AnyCodable([
                    OpenClawProtocol.AnyCodable([
                        "type": OpenClawProtocol.AnyCodable("text"),
                        "text": OpenClawProtocol.AnyCodable("spoken transcript"),
                    ]),
                ]),
                "timestamp": OpenClawProtocol.AnyCodable(1234.5),
            ]),
        ])
        let frame = EventFrame(type: "event", event: "session.message", payload: payload, seq: 1, stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))

        switch mapped {
        case let .sessionMessage(message):
            #expect(message.sessionKey == "agent:main:main")
            #expect(message.messageId == "msg-1")
            #expect(message.messageSeq == 7)
            #expect(message.message?.role == "user")
            #expect(message.message?.content.first?.text == "spoken transcript")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test func `unknown event maps to nil`() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: OpenClawProtocol.AnyCodable(["a": OpenClawProtocol.AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.event(frame))
        #expect(mapped == nil)
    }

    @Test func `seq gap maps to seq gap`() {
        let mapped = MacGatewayChatTransport.mapPushToTransportEvent(.seqGap(expected: 1, received: 9))
        #expect({
            if case .seqGap = mapped {
                return true
            }
            return false
        }())
    }
}
