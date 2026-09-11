import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI
@testable import OpenClawKit

struct IOSGatewayChatTransportTests {
    private actor ProgressRequestRecorder {
        var params: [Data] = []

        func append(_ data: Data) {
            self.params.append(data)
        }

        func snapshot() -> [Data] {
            self.params
        }
    }

    @Test(arguments: [false, true, nil] as [Bool?])
    func `progress requests negotiate owner scope on the connected server`(supportsOwner: Bool?) async throws {
        let recorder = ProgressRequestRecorder()
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
        let gateway = GatewayNodeSession()
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://progress-transport-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: socketSession),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let transport = IOSGatewayChatTransport(gateway: gateway, globalAgentId: "main")
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
            await gateway.disconnect()
        } catch {
            await gateway.disconnect()
            throw error
        }
    }

    private struct RecordedRequest: Decodable, Sendable {
        let id: String
        let method: String
        let params: [String: AnyCodable]
        let expectedProfileId: String?
    }

    private actor RequestRecorder {
        private var requests: [RecordedRequest] = []

        func record(_ data: Data) throws -> RecordedRequest {
            let request = try JSONDecoder().decode(RecordedRequest.self, from: data)
            self.requests.append(request)
            return request
        }

        func all() -> [RecordedRequest] {
            self.requests
        }
    }

    @MainActor
    private final class AcceptedRunRecorder {
        private(set) var values: [(binding: IOSNativeActionBinding, runID: String, sessionID: String?)] = []

        func record(binding: IOSNativeActionBinding, runID: String, sessionID: String?) {
            self.values.append((binding, runID, sessionID))
        }
    }

    private func observingRunActivity(
        _ transport: IOSGatewayChatTransport,
        recorder: AcceptedRunRecorder) -> IOSGatewayChatTransport
    {
        IOSGatewayChatTransport(
            gateway: transport.gateway,
            globalAgentId: transport.globalAgentId,
            outboxGatewayID: transport.outboxGatewayID,
            nativeBinding: transport.nativeBinding,
            captureRunActivity: { target, route in
                guard let binding = try await IOSGatewayChatTransport.captureRunActivityBinding(
                    gateway: transport.gateway,
                    route: route,
                    target: target,
                    nativeBinding: transport.nativeBinding)
                else { return nil }
                return (binding, { runID, sessionID in
                    recorder.record(binding: binding, runID: runID, sessionID: sessionID)
                })
            })
    }

    private func withSessionTransport(
        gateway: GatewayNodeSession = GatewayNodeSession(),
        unreadAckAdvertisement: Bool? = true,
        gatewayID: String? = nil,
        capabilities: [String] = [],
        nativeProfileID: String? = nil,
        sendPayload: String = #"{"runId":"submitted-run","status":"started"}"#,
        activityOwner: String? = nil,
        retireOnRequest: String? = nil,
        _ run: (IOSGatewayChatTransport, RequestRecorder) async throws -> Void) async throws
    {
        let recorder = RequestRecorder()
        let ownerData = try JSONEncoder().encode(["profile": ["id": activityOwner ?? ""]])
        let ownerPayload = try #require(String(bytes: ownerData, encoding: .utf8))
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let request = try await recorder.record(data)
                let payload = switch request.method {
                case "agents.list": GatewayWebSocketTestSupport.agentCatalogPayload
                case "sessions.create": #"{"key":"forked"}"#
                case "health": #"{"ok":true}"#
                case "chat.history":
                    """
                    {"sessionKey":"agent:reviewer:main","messages":[],
                     "sessionInfo":{"key":"agent:reviewer:main","agentId":"reviewer"}}
                    """
                case "chat.send": sendPayload
                case "users.self": ownerPayload
                case "sessions.messages.subscribe": #"{"subscribed":true,"key":"agent:reviewer:main"}"#
                default: #"{"entry":{}}"#
                }
                if request.method == retireOnRequest {
                    await gateway._test_handleChannelDisconnected("retired admission", socketGeneration: 1)
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#.utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let hello = GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: ["agents.list", "sessions.patch", "sessions.delete", "sessions.create"] +
                        (activityOwner == nil ? [] : ["users.self", "push.liveActivity.prepare"]),
                    capabilities: capabilities +
                        (unreadAckAdvertisement == true ? ["session-unread-ack-contract"] : []))
                guard unreadAckAdvertisement == nil else { return .data(hello) }
                var frame = try #require(JSONSerialization.jsonObject(with: hello) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var features = try #require(payload["features"] as? [String: Any])
                features.removeValue(forKey: "capabilities")
                payload["features"] = features
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = gatewayID
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://session-transport-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let binding: IOSNativeActionBinding?
            if let nativeProfileID {
                let ownerID = try #require(gatewayID)
                binding = try IOSNativeActionBinding(
                    session: OpenClawNativeSessionRef(
                        owner: .init(gatewayID: ownerID, profileID: nativeProfileID),
                        agentID: "reviewer",
                        sessionKey: "agent:reviewer:main"),
                    gateway: gateway,
                    route: #require(await gateway.currentRoute(ifGatewayID: ownerID)))
            } else {
                binding = nil
            }
            try await run(IOSGatewayChatTransport(
                gateway: gateway,
                globalAgentId: " Reviewer ",
                outboxGatewayID: gatewayID,
                nativeBinding: binding), recorder)
            await gateway.disconnect()
        } catch {
            await gateway.disconnect()
            throw error
        }
    }

    @Test(arguments: [false, true])
    func `native send lease retains actual CAS support and refuses a retired socket`(supportsCAS: Bool) async throws {
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["chat-send-routing-contract"] + (supportsCAS ? ["session-settings-cas-v1"] : []))
        { transport, recorder in
            let captured = try #require(await transport.gateway.currentRoute(ifGatewayID: "gateway-a"))
            guard case let .available(lease) = await transport.acquireOutboxRouteLease(ifCurrentRoute: captured) else {
                Issue.record("Expected a lease from the selected socket")
                return
            }
            #expect(lease.supportsSessionSettingsCAS == supportsCAS)
            await transport.gateway.disconnect()
            guard case .unavailable = await transport.acquireOutboxRouteLease(ifCurrentRoute: captured) else {
                Issue.record("A retired socket must not acquire a successor lease")
                return
            }
            await #expect(throws: Error.self) {
                try await lease.sendMessage(
                    sessionKey: "agent:reviewer:main",
                    agentID: "reviewer",
                    message: "intentional message",
                    thinking: "auto",
                    idempotencyKey: "test-invocation",
                    attachments: [])
            }
            #expect(await recorder.all().map(\.method) == ["agents.list"])
        }
    }

    @Test func `new session roster preserves selectable choices on its captured connection`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let lease = try #require(await transport.acquireNewSessionRouteLease())
            let roster = try await lease.listAgents()
            #expect(roster == OpenClawChatAgentsListResponse(
                defaultId: "system",
                agents: [
                    OpenClawChatAgentChoice(id: "zeta", name: " Zeta ", workspaceGit: true),
                    OpenClawChatAgentChoice(id: "legacy"),
                    OpenClawChatAgentChoice(id: "alpha", workspaceGit: false),
                ]))
            await transport.gateway.disconnect()
            await #expect(throws: Error.self) {
                _ = try await lease.listAgents()
            }
            let requests = await recorder.all()
            #expect(requests.map(\.method) == ["agents.list"])
            #expect(requests.first?.params.isEmpty == true)
        }
    }

    @Test(arguments: [
        ("gateway-a", "gateway-b"),
        (" gateway-a ", "gateway-a"),
        ("gateway-e\u{301}", "gateway-\u{E9}"),
    ])
    func `chat outbox route keeps the exact gateway owner`(owner: String, otherOwner: String) async throws {
        let gateway = GatewayNodeSession()
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.deviceAuthGatewayID = owner
        options.allowStoredDeviceAuth = false
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://chat-transport-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let matching = IOSGatewayChatTransport(gateway: gateway, outboxGatewayID: owner)
            let foreign = IOSGatewayChatTransport(gateway: gateway, outboxGatewayID: otherOwner)

            #expect(await matching.currentSessionMutationRoute() != nil)
            #expect(await foreign.currentSessionMutationRoute() == nil)
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }

    @Test func `history compatibility rejects only the old unsupported input run field`() {
        let unsupportedField = "invalid chat.history params: at root: unexpected property 'inputRunIds'"
        let cases: [(String, String, String, Bool)] = [
            ("chat.history", "INVALID_REQUEST", unsupportedField, true),
            ("chat.send", "INVALID_REQUEST", unsupportedField, false),
            ("chat.history", "FORBIDDEN", unsupportedField, false),
            (
                "chat.history",
                "INVALID_REQUEST",
                "invalid chat.history params: at root: unexpected property 'cursor'",
                false),
            ("chat.history", "INVALID_REQUEST", "invalid chat.history params: missing sessionKey", false),
            ("chat.history", "INVALID_REQUEST", "\(unsupportedField); missing sessionKey", false),
        ]
        for (method, code, message, expected) in cases {
            let error = GatewayResponseError(method: method, code: code, message: message, details: nil)
            #expect(IOSGatewayChatTransport.isUnsupportedHistoryInputRunIDsError(error) == expected)
        }
        #expect(!IOSGatewayChatTransport.isUnsupportedHistoryInputRunIDsError(URLError(.timedOut)))
    }

    @Test func `composer mutation compatibility preserves legacy controls only for unknown catalogs`() {
        #expect(IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: nil,
            allowedByScope: false))
        #expect(IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: true,
            allowedByScope: true))
        #expect(!IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: true,
            allowedByScope: false))
        #expect(!IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: false,
            allowedByScope: true))
    }

    @Test func `composer skill owner follows canonical session agent`() {
        let selected = IOSGatewayChatTransport.sessionTarget(
            for: "main",
            selectedAgentID: "reviewer")
        let canonical = IOSGatewayChatTransport.sessionTarget(
            for: "agent:ops:main",
            selectedAgentID: "reviewer")

        #expect(IOSGatewayChatTransport.composerAgentID(for: selected) == "reviewer")
        #expect(IOSGatewayChatTransport.composerAgentID(for: canonical) == "ops")
    }

    @Test func `composer skill projection keeps agent filtering session enableable`() {
        let skill = SkillStatus(
            name: "Weather",
            description: "Forecasts",
            source: "openclaw-managed",
            filePath: "/tmp/weather/SKILL.md",
            baseDir: "/tmp/weather",
            skillKey: "weather",
            primaryEnv: nil,
            emoji: nil,
            homepage: nil,
            always: false,
            disabled: false,
            blockedByAgentFilter: true,
            eligible: false,
            requirements: SkillRequirements(bins: [], env: [], config: []),
            missing: SkillMissing(bins: [], env: [], config: []),
            configChecks: [],
            install: [])

        let projected = IOSGatewayChatTransport.composerSkill(skill)

        #expect(projected.baseEnabled)
        #expect(projected.agentFiltered)
        #expect(!projected.blocked)
    }

    @Test func `composer tool projection accepts only MCP tools and preserves inherited denial`() throws {
        let result = ToolsEffectiveResult(
            agentid: "main",
            profile: "default",
            groups: [ToolsEffectiveGroup(
                id: AnyCodable("tools"),
                label: "Tools",
                source: AnyCodable("mixed"),
                tools: [
                    ToolsEffectiveEntry(
                        id: "mcp-github-create-issue",
                        label: "Create issue",
                        description: "",
                        rawdescription: "",
                        source: AnyCodable("mcp"),
                        mcpserver: "github",
                        mcptoolname: "create_issue",
                        deniedbysession: true),
                    ToolsEffectiveEntry(
                        id: "core-spoof",
                        label: "Spoof",
                        description: "",
                        rawdescription: "",
                        source: AnyCodable("core"),
                        mcpserver: "github",
                        mcptoolname: "spoof"),
                ])])

        let tools = try #require(IOSGatewayChatTransport.composerToolsByServer(result)["github"])
        #expect(tools.map(\.name) == ["create_issue"])
        #expect(tools.first?.baseEnabled == true)
        #expect(tools.first?.sessionDenied == true)
    }

    @Test func `model patch result decodes authoritative Luna thinking state`() throws {
        let data = Data(
            #"""
            {
              "entry":{"thinkingLevel":"ultra"},
              "resolved":{
                "modelProvider":"openai",
                "model":"gpt-5.6-luna",
                "thinkingLevel":"max",
                "thinkingLevels":[{"id":"off","label":"off"},{"id":"max","label":"max"}]
              }
            }
            """#.utf8)

        let result = try IOSGatewayChatTransport.decodeModelPatchResult(data)

        #expect(result.modelProvider == "openai")
        #expect(result.model == "gpt-5.6-luna")
        #expect(result.thinkingLevel == "max")
        #expect(result.thinkingLevels?.map(\.id) == ["off", "max"])
    }

    @Test func `live routing guard permits an identity still loading`() {
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            nil,
            serverSupportsGuard: true) == nil)
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            " per-sender|main|reviewer ",
            serverSupportsGuard: true) == "per-sender|main|reviewer")
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            "per-sender|main|reviewer",
            serverSupportsGuard: false) == nil)
    }

    @Test func `routing contract round trips a delimited legacy main key`() throws {
        let contract = try #require(OpenClawChatSessionRoutingContract.make(
            scope: "per-sender",
            mainKey: "team|primary",
            defaultAgentID: "main"))
        let components = try #require(OpenClawChatSessionRoutingContract.parse(contract))
        #expect(components.scope == "per-sender")
        #expect(components.mainKey == "team|primary")
        #expect(components.defaultAgentID == "main")
    }

    @Test func `hello advertises guarded chat send capability`() throws {
        let data = Data(
            #"""
            {
              "type":"hello-ok",
              "protocol":4,
              "server":{"version":"test","connId":"test"},
              "features":{"methods":[],"events":[],"capabilities":["chat-send-routing-contract","session-scoped-chat-metadata","session-unread-ack-contract"]},
              "snapshot":{
                "presence":[],
                "health":{},
                "stateVersion":{"presence":0,"health":0},
                "uptimeMs":0
              },
              "auth":{},
              "policy":{}
            }
            """#.utf8)
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)
        #expect(hello.supportsServerCapability(.chatSendRoutingContract))
        #expect(hello.supportsServerCapability(.sessionScopedChatMetadata))
        #expect(hello.supportsServerCapability(.sessionUnreadAckContract))
        #expect(!hello.supportsServerCapability(.sessionSettingsContract))
        #expect(!hello.supportsServerCapability(.sessionSettingsCAS))

        let currentData = Data(
            String(decoding: data, as: UTF8.self)
                .replacingOccurrences(
                    of: "session-unread-ack-contract\"]",
                    with: "session-unread-ack-contract\",\"session-settings-contract\",\"session-settings-cas-v1\"]")
                .utf8)
        let current = try JSONDecoder().decode(HelloOk.self, from: currentData)
        #expect(current.supportsServerCapability(.sessionSettingsContract))
        #expect(current.supportsServerCapability(.sessionSettingsCAS))
    }

    @Test func `session mutations dispatch normalized selected agent targets`() async throws {
        try await self.withSessionTransport { transport, recorder in
            for key in ["Matrix:Channel:Room", "global", "agent:ops:main"] {
                try await transport.patchSession(key: key, pinned: true)
                try await transport.deleteSession(key: key)
                _ = try await transport.forkSession(parentKey: key, fromLastCompleted: false)
            }

            let requests = await recorder.all()
            #expect(requests.map(\.method) == Array(
                repeating: ["sessions.patch", "sessions.delete", "sessions.create"],
                count: 3).flatMap(\.self))

            for (offset, expectedKey, expectedMutationAgentID, expectedForkAgentID) in [
                (0, "agent:reviewer:Matrix:Channel:Room", nil, "reviewer"),
                (3, "global", "reviewer", "reviewer"),
                (6, "agent:ops:main", nil, "ops"),
            ] as [(Int, String, String?, String?)] {
                let patch = requests[offset].params
                #expect(patch["key"]?.value as? String == expectedKey)
                #expect(patch["agentId"]?.value as? String == expectedMutationAgentID)
                #expect(patch["pinned"]?.value as? Bool == true)

                let delete = requests[offset + 1].params
                #expect(delete["key"]?.value as? String == expectedKey)
                #expect(delete["agentId"]?.value as? String == expectedMutationAgentID)
                #expect(delete["deleteTranscript"]?.value as? Bool == true)

                let fork = requests[offset + 2].params
                #expect(fork["parentSessionKey"]?.value as? String == expectedKey)
                #expect(fork["agentId"]?.value as? String == expectedForkAgentID)
                #expect(fork["fork"]?.value as? Bool == true)
            }
        }
    }

    @Test func `archive and restore carry the observed session identity`() async throws {
        try await self.withSessionTransport { transport, recorder in
            try await transport.patchSession(
                key: "global",
                expectedSessionID: " session-a ",
                archived: true)
            try await transport.patchSession(
                key: "global",
                expectedSessionID: "session-a",
                archived: false)

            let requests = await recorder.all()
            #expect(requests.map(\.method) == ["sessions.patch", "sessions.patch"])
            #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
            #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "reviewer" })
            #expect(requests.allSatisfy { $0.params["expectedSessionId"]?.value as? String == "session-a" })
            #expect(requests[0].params["archived"]?.value as? Bool == true)
            #expect(requests[1].params["archived"]?.value as? Bool == false)
        }
    }

    @Test func `thinking changes dispatch through selected agent session target`() async throws {
        try await self.withSessionTransport { transport, recorder in
            try await transport.setSessionThinking(sessionKey: "global", thinkingLevel: "high")

            let request = try #require(await recorder.all().first)
            #expect(request.method == "sessions.patch")
            #expect(request.params["key"]?.value as? String == "global")
            #expect(request.params["agentId"]?.value as? String == "reviewer")
            #expect(request.params["thinkingLevel"]?.value as? String == "high")
        }
    }

    @Test func `advanced session creation forwards agent worktree and base ref`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let created = try await transport.createSession(
                key: "agent:builder:ios-new",
                label: "Build",
                agentID: " Builder ",
                parentSessionKey: "agent:builder:main",
                worktree: true,
                worktreeBaseRef: " origin/release ")

            #expect(created.key == "forked")
            let request = try #require(await recorder.all().first)
            #expect(request.method == "sessions.create")
            #expect(request.params["key"]?.value as? String == "agent:builder:ios-new")
            #expect(request.params["label"]?.value as? String == "Build")
            #expect(request.params["agentId"]?.value as? String == "builder")
            #expect(request.params["parentSessionKey"]?.value as? String == "agent:builder:main")
            #expect(request.params["worktree"]?.value as? Bool == true)
            #expect(request.params["worktreeBaseRef"]?.value as? String == "origin/release")
        }
    }

    @Test func `verbosity patches preserve set and clear values`() async throws {
        try await self.withSessionTransport { transport, recorder in
            _ = try await transport.patchSessionSettings(
                sessionKey: "global",
                agentID: nil,
                patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some("full")))
            _ = try await transport.patchSessionSettings(
                sessionKey: "global",
                agentID: nil,
                patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some(nil)))

            let requests = await recorder.all()
            #expect(requests.count == 2)
            #expect(requests.allSatisfy { $0.method == "sessions.patch" })
            #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
            #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "reviewer" })
            #expect(requests[0].params["verboseLevel"]?.value as? String == "full")
            #expect(requests[1].params["verboseLevel"]?.value is NSNull)
            #expect(requests.allSatisfy { $0.params["model"] == nil })
            #expect(requests.allSatisfy { $0.params["thinkingLevel"] == nil })
        }
    }

    @Test func `fast mode patches preserve boolean and explicit null`() async throws {
        try await self.withSessionTransport { transport, recorder in
            _ = try await transport.patchSessionSettings(
                sessionKey: "global",
                agentID: nil,
                patch: OpenClawChatSessionSettingsPatch(fastMode: .some(.on)))
            _ = try await transport.patchSessionSettings(
                sessionKey: "global",
                agentID: nil,
                patch: OpenClawChatSessionSettingsPatch(fastMode: .some(nil)))

            let requests = await recorder.all()
            #expect(requests.count == 2)
            #expect(requests[0].params["fastMode"]?.value as? Bool == true)
            #expect(requests[1].params["fastMode"]?.value is NSNull)
            #expect(requests.allSatisfy { $0.params["verboseLevel"] == nil })
        }
    }

    @Test(arguments: [true, false, nil] as [Bool?])
    func `session mutation leases preserve advertised and omitted read capabilities`(
        unreadAckAdvertisement: Bool?) async throws
    {
        try await self.withSessionTransport(unreadAckAdvertisement: unreadAckAdvertisement) { transport, recorder in
            let lease = try #require(await transport.acquireSessionMutationRouteLease())
            try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                pinned: true,
                archived: nil,
                unread: nil)
            try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                pinned: nil,
                archived: nil,
                unread: true)
            for marker in [nil, .some(nil), .some(1234.5)] as [Double??] {
                try await lease.patchSession(
                    key: "global",
                    expectedMarkedUnreadAt: marker,
                    label: nil,
                    category: nil,
                    pinned: nil,
                    archived: nil,
                    unread: false)
            }

            let requests = await recorder.all()
            try #require(requests.count == 5)
            #expect(requests.allSatisfy { $0.method == "sessions.patch" })
            #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
            #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "reviewer" })
            #expect(requests[0].params["pinned"]?.value as? Bool == true)
            #expect(requests[0].params["unread"] == nil)
            #expect(requests[1].params["unread"]?.value as? Bool == true)
            if unreadAckAdvertisement == true {
                #expect(requests[2].params["expectedMarkedUnreadAt"] == nil)
                #expect(requests[3].params["expectedMarkedUnreadAt"]?.value is NSNull)
                #expect(requests[4].params["expectedMarkedUnreadAt"]?.value as? Double == 1234.5)
            } else {
                #expect(requests.allSatisfy { $0.params["expectedMarkedUnreadAt"] == nil })
            }
            #expect(requests.dropFirst(2).allSatisfy { $0.params["unread"]?.value as? Bool == false })
        }
    }

    @Test func `requests fail fast when gateway not connected`() async {
        let gateway = GatewayNodeSession()
        let transport = IOSGatewayChatTransport(gateway: gateway)

        do {
            _ = try await transport.requestHistory(sessionKey: "node-test")
            Issue.record("Expected requestHistory to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                message: "hello",
                thinking: "low",
                idempotencyKey: "idempotency",
                attachments: [])
            Issue.record("Expected sendMessage to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                agentID: "main",
                expectedSessionRoutingContract: "per-sender|main|main",
                message: "hello",
                thinking: "low",
                idempotencyKey: "guarded-idempotency",
                attachments: [])
            Issue.record("Expected guarded sendMessage to fail before dispatch")
        } catch is OpenClawChatTransportSendError {
            // Expected: a missing route never reached chat.send.
        } catch {
            Issue.record("Expected a typed pre-dispatch failure, got \(error)")
        }

        do {
            _ = try await transport.requestHealth(timeoutMs: 250)
            Issue.record("Expected requestHealth to throw when gateway not connected")
        } catch {}

        do {
            try await transport.resetSession(sessionKey: "node-test")
            Issue.record("Expected resetSession to throw when gateway not connected")
        } catch {}

        do {
            try await transport.setActiveSessionKey("node-test")
            Issue.record("Expected setActiveSessionKey to throw when gateway not connected")
        } catch {}
    }

    @Test func `maps session message event to session message`() {
        let payload = AnyCodable([
            "sessionKey": AnyCodable("agent:main:main"),
            "agentId": AnyCodable("main"),
            "messageId": AnyCodable("msg-1"),
            "messageSeq": AnyCodable(7),
            "message": AnyCodable([
                "role": AnyCodable("assistant"),
                "content": AnyCodable([
                    AnyCodable([
                        "type": AnyCodable("text"),
                        "text": AnyCodable("agent reply"),
                    ]),
                ]),
                "timestamp": AnyCodable(1234.5),
            ]),
        ])
        let frame = EventFrame(
            type: "event",
            event: "session.message",
            payload: payload,
            seq: 1,
            stateversion: nil)
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)

        switch mapped {
        case let .sessionMessage(message):
            #expect(message.sessionKey == "agent:main:main")
            #expect(message.agentId == "main")
            #expect(message.messageId == "msg-1")
            #expect(message.messageSeq == 7)
            #expect(message.message?.role == "assistant")
            #expect(message.message?.content.first?.text == "agent reply")
            #expect(message.message?.transcriptMessageID == "msg-1")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test @MainActor func `canonical transcript identity deduplicates replayed assistant messages`() {
        let original = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let replay = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let messages = OpenClawChatViewModel.dedupeMessages([original, replay])

        #expect(messages.count == 1)
        #expect(messages.first?.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `distinct transcript identities preserve identical assistant replies`() {
        let first = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let second = Self.canonicalAssistantMessage(
            timestamp: 1234.5,
            transcriptMessageID: "canonical-assistant-2")

        let messages = OpenClawChatViewModel.dedupeMessages([first, second])

        #expect(messages.count == 2)
        #expect(messages.map(\.transcriptMessageID) == ["canonical-assistant-1", "canonical-assistant-2"])
    }

    @Test @MainActor func `history reconciles a replay by its canonical transcript identity`() {
        let original = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let replay = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let messages = OpenClawChatViewModel.reconcileMessageIDs(
            previous: [original],
            incoming: [replay])

        #expect(messages.count == 1)
        #expect(messages.first?.id == original.id)
        #expect(messages.first?.timestamp == replay.timestamp)
        #expect(messages.first?.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `canonical adoption keeps the durable transcript identity`() {
        let existing = OpenClawChatMessage(
            role: "assistant",
            content: [Self.assistantText],
            timestamp: 1234.5)
        let incoming = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let adopted = OpenClawChatViewModel.adoptingCanonicalMessage(incoming, over: existing)

        #expect(adopted.id == existing.id)
        #expect(adopted.timestamp == incoming.timestamp)
        #expect(adopted.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `user idempotency still reconciles an optimistic canonical echo`() {
        let original = OpenClawChatMessage(
            role: "user",
            content: [Self.assistantText],
            timestamp: 1234.5,
            idempotencyKey: "run-1:user")
        let echo = OpenClawChatMessage(
            role: "user",
            content: [Self.assistantText],
            timestamp: 5678.5,
            transcriptMessageID: "canonical-user-1",
            idempotencyKey: "run-1:user")

        let messages = OpenClawChatViewModel.reconcileMessageIDs(
            previous: [original],
            incoming: [echo])

        #expect(messages.count == 1)
        #expect(messages.first?.id == original.id)
        #expect(messages.first?.transcriptMessageID == "canonical-user-1")
    }

    private static var assistantText: OpenClawChatMessageContent {
        OpenClawChatMessageContent(
            type: "text",
            text: "agent reply",
            mimeType: nil,
            fileName: nil,
            content: nil)
    }

    private static func canonicalAssistantMessage(
        timestamp: Double,
        transcriptMessageID: String = "canonical-assistant-1") -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: "assistant",
            content: [self.assistantText],
            timestamp: timestamp,
            transcriptMessageID: transcriptMessageID)
    }

    @Test func `maps sessions changed event to authoritative refresh signal`() {
        let payload = AnyCodable([
            "sessionKey": AnyCodable("agent:main:main"),
            "agentId": AnyCodable("main"),
            "reason": AnyCodable("command-metadata"),
        ])
        let frame = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: payload,
            seq: 1,
            stateversion: nil)

        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)
        guard case let .sessionsChanged(change) = mapped else {
            Issue.record("expected .sessionsChanged, got \(String(describing: mapped))")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))
    }

    @Test func `maps chat event to chat`() {
        let payload = AnyCodable([
            "runId": AnyCodable("run-1"),
            "sessionKey": AnyCodable("main"),
            "state": AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func `maps unknown event to nil`() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: AnyCodable(["a": AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)
        #expect(mapped == nil)
    }
}

extension IOSGatewayChatTransportTests {
    private actor WidgetFixture {
        var profileID: String
        private var responseCount = 0
        private var holdNext = false
        private var held: (GatewayTestWebSocketTask, Data)?
        private var heldWaiters: [CheckedContinuation<Void, Never>] = []

        init(profileID: String) {
            self.profileID = profileID
        }

        func setProfile(_ profileID: String) {
            self.profileID = profileID
        }

        func holdNextRefresh() {
            self.holdNext = true
        }

        func waitForHeldRefresh() async {
            if self.held != nil { return }
            await withCheckedContinuation { self.heldWaiters.append($0) }
        }

        func release() {
            if let (socket, data) = self.held { socket.emitReceiveSuccess(.data(data)) }
            self.held = nil
            let waiters = self.heldWaiters
            self.heldWaiters.removeAll()
            for waiter in waiters {
                waiter.resume()
            }
        }

        func respond(_ socket: GatewayTestWebSocketTask, request: RecordedRequest) throws {
            #expect(request.method == "plugin.surface.refresh")
            self.responseCount += 1
            let allowed = request.expectedProfileId.map { $0.utf8.elementsEqual(self.profileID.utf8) } ?? true
            var frame: [String: Any] = ["type": "res", "id": request.id, "ok": allowed]
            if allowed {
                frame["payload"] = ["pluginSurfaceUrls": [
                    "canvas": "http://widget-test.invalid:9443/__openclaw__/cap/refresh-\(self.responseCount)",
                ]]
            } else {
                frame["error"] = [
                    "code": "INVALID_REQUEST", "message": "Selected profile changed",
                    "details": ["reason": "EXPECTED_PROFILE_MISMATCH"],
                ]
            }
            let data = try JSONSerialization.data(withJSONObject: frame)
            if self.holdNext {
                self.holdNext = false
                self.held = (socket, data)
                let waiters = self.heldWaiters
                self.heldWaiters.removeAll()
                for waiter in waiters {
                    waiter.resume()
                }
            } else {
                socket.emitReceiveSuccess(.data(data))
            }
        }
    }

    private func connectWidgetTransport(
        gateway: GatewayNodeSession, fixture: WidgetFixture, recorder: RequestRecorder, profileID: String)
        async throws -> IOSGatewayChatTransport
    {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                try await fixture.respond(socket, request: recorder.record(data))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    canvasPluginSurfaceURL: "http://widget-test.invalid:9443/__openclaw__/cap/hello",
                    methods: ["plugin.surface.refresh"], capabilities: ["profile-binding-v1"]))
            })
        })
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = "widget-gateway"
        try await gateway.connect(
            url: #require(URL(string: "ws://widget-test.invalid")),
            credentials: .init(), connectOptions: options, sessionBox: WebSocketSessionBox(session: session),
            onConnected: {}, onDisconnected: { _ in }, onInvoke: { .init(id: $0.id, ok: true) })
        let binding = try IOSNativeActionBinding(
            session: .init(
                owner: .init(gatewayID: "widget-gateway", profileID: profileID),
                agentID: "main", sessionKey: "agent:main:main"),
            gateway: gateway, route: #require(await gateway.currentRoute()))
        return IOSGatewayChatTransport(gateway: gateway, nativeBinding: binding)
    }

    private func withWidgetTransport(
        profileID: String = "alice",
        _ run: (IOSGatewayChatTransport, WidgetFixture, RequestRecorder) async throws -> Void) async throws
    {
        let gateway = GatewayNodeSession()
        let fixture = WidgetFixture(profileID: profileID)
        let recorder = RequestRecorder()
        do {
            let transport = try await self.connectWidgetTransport(
                gateway: gateway, fixture: fixture, recorder: recorder, profileID: profileID)
            try await run(transport, fixture, recorder)
        } catch {
            await fixture.release()
            await gateway.disconnect()
            throw error
        }
        await fixture.release()
        await gateway.disconnect()
    }

    @Test(arguments: [" alice ", "profile-e\u{301}", "profile-\u{E9}"])
    func `native widget acquisition and denial preserve exact owners before ordinary chat resumes`(
        profileID: String) async throws
    {
        try await self.withWidgetTransport(profileID: profileID) { transport, fixture, recorder in
            let path = "/__openclaw__/canvas/documents/test/index.html"
            let initial = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            #expect(initial.url.path.contains("/cap/refresh-1/"))
            #expect(initial.url.scheme == "http")
            #expect(initial.url.host == "widget-test.invalid")
            #expect(initial.url.port == 9443)
            let recovered = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: initial))
            #expect(recovered.url.path.contains("/cap/refresh-2/"))
            // Clear the resolver's recovery-attempt history before the next failure.
            let current = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            await fixture.setProfile("bob")
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: current) == nil)
            let denied = await recorder.all()
            #expect(denied.count == 3)
            #expect(denied.allSatisfy { $0.expectedProfileId?.utf8.elementsEqual(profileID.utf8) == true })
            #expect(denied.allSatisfy { $0.params["expectedProfileId"] == nil })
            let binding = try #require(transport.nativeBinding)
            #expect(await transport.gateway.currentCanvasHostRoute(
                ifCurrentRoute: binding.route, expectedProfileId: profileID) == nil)
            let bobBinding = IOSNativeActionBinding(
                session: .init(
                    owner: .init(gatewayID: "widget-gateway", profileID: "bob"),
                    agentID: "main", sessionKey: "agent:main:main"),
                gateway: transport.gateway, route: binding.route)
            let bob = IOSGatewayChatTransport(gateway: transport.gateway, nativeBinding: bobBinding)
            #expect(await bob.resolveInlineWidgetResource(path: path, replacing: nil) != nil)
            let ordinary = IOSGatewayChatTransport(gateway: transport.gateway)
            let unbound = try #require(await ordinary.resolveInlineWidgetResource(path: path, replacing: nil))
            #expect(unbound.url.path.contains("/cap/refresh-5/"))
            let requests = await recorder.all()
            try #require(requests.count == 5)
            #expect(requests[3].expectedProfileId == "bob")
            #expect(requests[4].expectedProfileId == nil)
        }
    }

    @Test func `retired widget lookup and held recovery cannot use a successor socket`() async throws {
        try await self.withWidgetTransport { transport, fixture, recorder in
            let path = "/__openclaw__/canvas/documents/test/index.html"
            let initial = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            await fixture.holdNextRefresh()
            async let loading = transport.resolveInlineWidgetResource(path: path, replacing: initial)
            try await AsyncTimeout.withTimeout(
                seconds: 2, onTimeout: { URLError(.timedOut) },
                operation: { await fixture.waitForHeldRefresh() })
            await transport.gateway.disconnect()
            let successorRecorder = RequestRecorder()
            let successor = try await self.connectWidgetTransport(
                gateway: transport.gateway, fixture: fixture, recorder: successorRecorder, profileID: "alice")
            await fixture.release()
            #expect(await loading == nil)
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(await recorder.all().count == 2)
            #expect(await successorRecorder.all().isEmpty)
            #expect(await successor.resolveInlineWidgetResource(path: path, replacing: nil) != nil)
            #expect(await successorRecorder.all().map(\.expectedProfileId) == ["alice"])
        }
    }

    @Test(.serialized, arguments: [false, true])
    @MainActor func `app transport gates activity owner lookup on consent and push eligibility`(
        consent: Bool) async throws
    {
        try await withUserDefaults([PushEnrollmentConsent.disclosureAcceptedKey: consent]) {
            let appModel = NodeAppModel()
            defer { appModel.disconnectGateway() }
            let operationsAvailable = await PushRegistrationManager().activityOperationsAvailable()
            let eligible = consent && operationsAvailable
            try await self.withSessionTransport(
                gateway: appModel.operatorSession,
                gatewayID: "gateway-a",
                capabilities: ["profile-binding-v1"],
                activityOwner: "profile-a")
            { _, recorder in
                let transport = await appModel.makeChatTransport(outboxGatewayID: "gateway-a")
                let response = try await transport.sendMessage(
                    sessionKey: "agent:reviewer:main",
                    message: "one invocation",
                    thinking: "",
                    idempotencyKey: "app-send",
                    attachments: [])
                #expect(response.runId == "submitted-run")
                #expect((response.onAcceptedRun != nil) == eligible)
                let requests = await recorder.all()
                #expect(requests.map(\.method) == (eligible ? ["users.self", "chat.send"] : ["chat.send"]))
                #expect(try #require(requests.last).expectedProfileId == (eligible ? "profile-a" : nil))
            }
        }
    }

    @Test(arguments: [false, true], [nil, "committed-session"] as [String?])
    func `activity callback uses the actual ACK and immutable dispatch owner`(
        native: Bool, sessionID: String?) async throws
    {
        let accepted = await AcceptedRunRecorder()
        let profileID = "profile-e\u{301}"
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["profile-binding-v1"],
            nativeProfileID: native ? profileID : nil,
            sendPayload: #"{"runId":"server-accepted-run","status":"started"}"#,
            activityOwner: profileID)
        { base, recorder in
            let transport = self.observingRunActivity(base, recorder: accepted)
            let route = try #require(await transport.gateway.currentRoute(ifGatewayID: "gateway-a"))
            let response = try await transport.sendMessage(
                sessionKey: "agent:reviewer:main",
                message: "one invocation",
                thinking: nil,
                idempotencyKey: "client-invocation",
                attachments: [],
                ifCurrentRoute: route)
            #expect(response.runId == "server-accepted-run")
            #expect(await accepted.values.isEmpty)
            let requests = await recorder.all()
            #expect(requests.map(\.method) == ["users.self", "chat.send"])
            let ownerRequest = try #require(requests.first)
            #expect(ownerRequest.expectedProfileId.map { Array($0.utf8) } ==
                (native ? Array(profileID.utf8) : nil))
            let send = try #require(requests.last)
            #expect(send.expectedProfileId.map { Array($0.utf8) } == Array(profileID.utf8))
            #expect(send.params["expectedProfileId"] == nil)
            #expect(send.params["idempotencyKey"]?.value as? String == "client-invocation")

            await transport.gateway.disconnect()
            let callback = try #require(response.onAcceptedRun)
            await callback(sessionID)
            let values = await accepted.values
            #expect(values.count == 1)
            let observed = try #require(values.first)
            #expect(observed.runID == "server-accepted-run")
            #expect(observed.sessionID == sessionID)
            #expect(observed.binding.session == .init(
                owner: .init(gatewayID: "gateway-a", profileID: profileID),
                agentID: "reviewer",
                sessionKey: "agent:reviewer:main"))
            #expect(observed.binding.gateway === transport.gateway)
            #expect(observed.binding.route == route)
            #expect(await observed.binding.isCurrent() == false)
            #expect(await recorder.all().count == 2)
        }
    }

    @Test(arguments: [false, true])
    func `capture cancellation and failure are not dispatched`(cancelled: Bool) async throws {
        try await self.withSessionTransport(gatewayID: "gateway-a") { base, recorder in
            let transport = IOSGatewayChatTransport(
                gateway: base.gateway,
                outboxGatewayID: base.outboxGatewayID,
                captureRunActivity: { _, _ in
                    if cancelled { throw CancellationError() }
                    throw URLError(.notConnectedToInternet)
                })
            await #expect(throws: OpenClawChatTransportSendError.notDispatched) {
                _ = try await transport.sendMessage(
                    sessionKey: "agent:reviewer:main",
                    message: "one invocation",
                    thinking: "",
                    idempotencyKey: "not-dispatched",
                    attachments: [])
            }
            #expect(await recorder.all().isEmpty)
        }
    }

    @Test(arguments: [
        ("", nil),
        ("profile-\u{E9}", nil),
        ("profile-e\u{301}", "users.self"),
    ] as [(String, String?)])
    func `activity capture rejects missing mismatched or retired authoritative owner`(
        profileID: String, retireOnRequest: String?) async throws
    {
        let accepted = await AcceptedRunRecorder()
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["profile-binding-v1"],
            nativeProfileID: "profile-e\u{301}",
            activityOwner: profileID,
            retireOnRequest: retireOnRequest)
        { base, recorder in
            let transport = self.observingRunActivity(base, recorder: accepted)
            await #expect(throws: OpenClawChatTransportSendError.notDispatched) {
                _ = try await transport.sendMessage(
                    sessionKey: "agent:reviewer:main",
                    message: "one invocation",
                    thinking: "",
                    idempotencyKey: "not-dispatched",
                    attachments: [])
            }
            #expect(await recorder.all().map(\.method) == ["users.self"])
            #expect(await accepted.values.isEmpty)
        }
    }

    @Test(arguments: [(false, true), (true, false)])
    func `unsupported activity capture preserves ordinary send without an observer`(
        profileSupported: Bool, activitySupported: Bool) async throws
    {
        let accepted = await AcceptedRunRecorder()
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: profileSupported ? ["profile-binding-v1"] : [],
            activityOwner: activitySupported ? "profile-a" : nil)
        { base, recorder in
            let response = try await self.observingRunActivity(base, recorder: accepted).sendMessage(
                sessionKey: "agent:reviewer:main",
                message: "one invocation",
                thinking: "",
                idempotencyKey: "unsupported-activity",
                attachments: [])
            #expect(response.runId == "submitted-run")
            #expect(response.onAcceptedRun == nil)
            #expect(await accepted.values.isEmpty)
            let requests = await recorder.all()
            #expect(requests.map(\.method) == ["chat.send"])
            #expect(try #require(requests.first).expectedProfileId == nil)
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `send completion policies survive activity capture and retired postresponse fences`(
        native: Bool, malformed: Bool) async throws
    {
        for observeActivity in [false, true] {
            let accepted = await AcceptedRunRecorder()
            try await self.withSessionTransport(
                gatewayID: "gateway-a",
                capabilities: ["profile-binding-v1"],
                nativeProfileID: native ? "profile-a" : nil,
                sendPayload: malformed ? #"{"status":"started"}"# : #"{"runId":"original-run","status":"started"}"#,
                activityOwner: "profile-a",
                retireOnRequest: "chat.send")
            { base, recorder in
                let transport = observeActivity ? self.observingRunActivity(base, recorder: accepted) : base
                let route = try #require(await transport.gateway.currentRoute(ifGatewayID: "gateway-a"))
                do {
                    let response = try await transport.sendMessage(
                        sessionKey: "agent:reviewer:main",
                        message: "one invocation",
                        thinking: nil,
                        idempotencyKey: "original-invocation",
                        attachments: [],
                        ifCurrentRoute: route)
                    #expect(native && !malformed)
                    #expect(response.runId == "original-run")
                    #expect((response.onAcceptedRun != nil) == observeActivity)
                } catch is CancellationError {
                    #expect(!native || malformed)
                }
                #expect(await transport.gateway.currentRoute(ifGatewayID: "gateway-a") != route)
                #expect(await recorder.all().filter { $0.method == "chat.send" }.count == 1)
                #expect(await accepted.values.isEmpty)
            }
        }
    }

    @Test(arguments: [nil, "profile-e\u{301}", "profile-\u{E9}"] as [String?])
    func `native chat forwards one exact profile through reads subscriptions and the existing send lease`(
        profileID: String?) async throws
    {
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["profile-binding-v1", "chat-send-routing-contract"],
            nativeProfileID: profileID)
        { transport, recorder in
            let history = try await transport.requestHistory(sessionKey: "agent:reviewer:main")
            #expect(history.sessionInfo?.key == "agent:reviewer:main")
            #expect(try await transport.requestHealth(timeoutMs: 250))
            try await transport.setActiveSessionKey("agent:reviewer:main")
            guard case let .available(lease) = await transport.acquireOutboxRouteLease() else {
                Issue.record("Expected the current transport's canonical send lease")
                return
            }
            let sent = try await lease.sendMessage(
                sessionKey: "agent:reviewer:main",
                agentID: "reviewer",
                message: "intentional message",
                thinking: "auto",
                idempotencyKey: "native-invocation",
                attachments: [])
            #expect(sent.runId == "submitted-run")
            let requests = await recorder.all()
            #expect(requests.map(\.method) == [
                "chat.history", "health", "sessions.messages.subscribe", "agents.list", "chat.send",
            ])
            for request in requests {
                #expect(request.expectedProfileId.map { Array($0.utf8) } == profileID.map { Array($0.utf8) })
                #expect(request.params["expectedProfileId"] == nil)
            }
            await transport.gateway.disconnect()
            await #expect(throws: Error.self) {
                _ = try await transport.requestHistory(sessionKey: "agent:reviewer:main")
            }
            #expect(await recorder.all().count == requests.count)
        }
    }

    @Test func `native chat without binding capability reports unavailable before any RPC`() async throws {
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            nativeProfileID: "profile-a")
        { transport, recorder in
            await #expect(throws: OpenClawNativeActionError.self) {
                _ = try await transport.requestHealth(timeoutMs: 250)
            }
            let event = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    var iterator = transport.events().makeAsyncIterator()
                    return await iterator.next()
                })
            guard case let .routeUnavailable(reason) = event else {
                Issue.record("Missing profile binding must visibly detach the native transport")
                return
            }
            #expect(reason.contains("Update the selected Gateway"))
            #expect(await recorder.all().isEmpty)
        }
    }

    @Test func `native history rejects a different canonical session before presentation`() async throws {
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["profile-binding-v1"],
            nativeProfileID: "profile-a")
        { transport, recorder in
            await #expect(throws: OpenClawNativeActionError.self) {
                _ = try await transport.requestHistory(sessionKey: "agent:reviewer:other")
            }
            #expect(await recorder.all().map(\.method) == ["chat.history"])
        }
    }

    @Test(arguments: ["profile-e\u{301}", "profile-\u{E9}", nil] as [String?])
    func `native event admission requires exact recipient and captured socket`(recipient: String?) async throws {
        try await self.withSessionTransport(
            gatewayID: "gateway-a",
            capabilities: ["profile-binding-v1"],
            nativeProfileID: "profile-e\u{301}")
        { transport, _ in
            let binding = try #require(transport.nativeBinding)
            let frame = EventFrame(
                type: "event",
                event: "session.message",
                payload: AnyCodable(["sessionKey": "agent:reviewer:main"]),
                seq: 1,
                stateversion: nil,
                recipientprofileid: recipient)
            #expect(await binding.accepts(frame) == (recipient?.utf8.elementsEqual("profile-e\u{301}".utf8) == true))
            await transport.gateway.disconnect()
            #expect(await binding.accepts(frame) == false)
        }
    }
}

struct LocalFixtureChatTransportTests {
    @Test(arguments: [
        (LocalChatFixture.appleReviewDemo, ["main"]),
        (LocalChatFixture.appScreenshots, ["main", "research", "automation"]),
    ])
    func `new session options expose fixture agents and create the selected session`(
        fixture: LocalChatFixture,
        expectedAgentIDs: [String]) async throws
    {
        let transport = LocalFixtureChatTransport(fixture: fixture)
        let route = try #require(await transport.acquireNewSessionRouteLease())
        let catalog = try #require(try await route.listAgents())

        #expect(catalog.defaultId == fixture.defaultAgentID)
        #expect(catalog.agents.map(\.id) == expectedAgentIDs)
        #expect(catalog.agents.allSatisfy { $0.workspaceGit == false })
        let selectedAgentID = try #require(catalog.agents.last?.id)
        let created = try await route.createSession(
            key: "fixture-selected-agent",
            label: nil,
            agentID: selectedAgentID,
            parentSessionKey: nil,
            worktree: nil,
            worktreeBaseRef: nil)
        #expect(created.key == "fixture-selected-agent")
    }

    @Test func `new session options reject unavailable agents and worktrees`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let route = try #require(await transport.acquireNewSessionRouteLease())

        await #expect(throws: NSError.self) {
            try await route.createSession(
                key: "unknown-agent",
                label: nil,
                agentID: "missing",
                parentSessionKey: nil,
                worktree: nil,
                worktreeBaseRef: nil)
        }
        await #expect(throws: NSError.self) {
            try await route.createSession(
                key: "unsupported-worktree",
                label: nil,
                agentID: "main",
                parentSessionKey: nil,
                worktree: true,
                worktreeBaseRef: "main")
        }
    }

    @Test func `sent user turn carries gateway idempotency metadata`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)

        _ = try await transport.sendMessage(
            sessionKey: "main",
            message: "hello",
            thinking: "auto",
            idempotencyKey: "fixture-run",
            attachments: [])
        let history = try await transport.requestHistory(sessionKey: "main")
        let decoded = try #require(history.messages).compactMap { payload -> OpenClawChatMessage? in
            guard let data = try? JSONEncoder().encode(payload) else { return nil }
            return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }

        #expect(decoded.last(where: { $0.role == "user" })?.idempotencyKey == "fixture-run:user")
    }

    @Test func `Apple Review fixture persists capability mutations into session readback`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)
        #expect(transport.supportsComposerCapabilities)
        let catalog = await transport.loadComposerCapabilityCatalog(sessionKey: "main", agentID: "main")
        #expect(catalog.permissionMutationAvailable)
        #expect(catalog.toolOverrideMutationAvailable)
        let overrides = OpenClawChatSessionToolOverrides(
            webSearch: false,
            skills: ["autoreview": false],
            mcpServers: ["GitHub": false])

        _ = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(
                expectedSessionID: "apple-review-demo-main",
                permissionMode: .some(.workspace),
                toolOverrides: .some(overrides)))

        let session = try #require(
            try await transport.listSessions(limit: nil, search: nil, archived: false).sessions.first)
        #expect(session.permissionMode == .workspace)
        #expect(session.toolOverrides == overrides)
    }
}
