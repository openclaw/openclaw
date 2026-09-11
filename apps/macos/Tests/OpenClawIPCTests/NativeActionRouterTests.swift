import AppKit
import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

final class MacNativeActionFixture: @unchecked Sendable {
    static let sessionKey = "agent:main:native"
    static var configuration: [String: Any] {
        ["gateway": ["mode": "remote", "remote": ["transport": "direct", "url": "ws://127.0.0.1:49383"]]]
    }

    let gateway: GatewayConnection
    let sockets: GatewayTestWebSocketSession
    let profileID = LockIsolated("profile-one")
    let routeAuthority = LockIsolated<UInt64?>(nil)
    let requests = LockIsolated<[Data]>([])
    let capabilities = LockIsolated([
        GatewayServerCapability.profileBinding.rawValue,
        GatewayServerCapability.chatSendRoutingContract.rawValue,
        GatewayServerCapability.sessionSettingsContract.rawValue,
        GatewayServerCapability.sessionSettingsCAS.rawValue,
    ])
    let heldRequest = LockIsolated<(GatewayTestWebSocketTask, Data)?>(nil)
    let healthOK = LockIsolated(true)
    let historySessionInfo = LockIsolated<[String: String]?>(nil)
    let holdObserverHides = LockIsolated(false)
    let profileRejections = LockIsolated<[String]>([])
    let artifactUsesHTTP = LockIsolated(false)
    let gatewayID: String

    init(holding method: String? = nil) throws {
        let gatewayID = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: Self.configuration))
        self.gatewayID = gatewayID
        let routeAuthority = self.routeAuthority
        let profileID = self.profileID
        let requests = self.requests
        let capabilities = self.capabilities
        let heldRequest = self.heldRequest
        let healthOK = self.healthOK
        let historySessionInfo = self.historySessionInfo
        let holdObserverHides = self.holdObserverHides
        let profileRejections = self.profileRejections
        let artifactUsesHTTP = self.artifactUsesHTTP
        let sockets = GatewayTestWebSocketSession {
            let advertised = capabilities.value
            return GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let id = try #require(frame["id"] as? String)
                let requestedMethod = try #require(frame["method"] as? String)
                requests.withValue { $0.append(data) }
                if let expected = frame["expectedProfileId"] as? String,
                   !expected.utf8.elementsEqual(profileID.value.utf8)
                {
                    profileRejections.withValue { $0.append(id) }
                    let rejection = try JSONSerialization.data(withJSONObject: [
                        "type": "res", "id": id, "ok": false,
                        "error": [
                            "code": "INVALID_REQUEST", "message": "Account changed",
                            "details": ["reason": "EXPECTED_PROFILE_MISMATCH", "execution": "not_started"],
                        ],
                    ])
                    socket.emitReceiveSuccess(.data(rejection))
                    return
                }
                let params = frame["params"] as? [String: Any] ?? [:]
                let payload: [String: Any]
                switch requestedMethod {
                case "health":
                    payload = ["ok": healthOK.value]
                case "users.self":
                    payload = ["profile": ["id": profileID.value]]
                case "agents.list":
                    payload = Self.agents
                case "models.list":
                    payload = ["models": [[
                        "id": "fixture-model", "name": "Fixture Model", "provider": "fixture", "available": true,
                    ]]]
                case "sessions.list":
                    payload = ["ts": 1, "sessions": [Self.session]]
                case "chat.history":
                    let key = params["sessionKey"] as? String ?? Self.sessionKey
                    payload = [
                        "sessionKey": key, "sessionId": "native-session",
                        "sessionInfo": historySessionInfo.value ??
                            ["key": key, "agentId": "main", "sessionId": "native-session"],
                        "messages": [], "thinkingLevel": "off",
                    ]
                case "chat.send":
                    payload = ["runId": "gateway-accepted-run", "status": "started"]
                case "commands.list":
                    payload = ["commands": []]
                case "plugin.surface.refresh":
                    payload = [
                        "surface": "canvas",
                        "pluginSurfaceUrls": ["canvas": "http://127.0.0.1:18789/__openclaw__/cap/rotation-\(index)"],
                    ]
                case "artifacts.download":
                    let artifact: [String: Any] = [
                        "id": "artifact_managed_image_native", "type": "image", "title": "Synthetic image",
                        "mimeType": "image/png", "sizeBytes": 5, "download": [:],
                    ]
                    payload = artifactUsesHTTP.value
                        ? [
                            "artifact": artifact,
                            "url": "/api/chat/media/outgoing/image?mediaTicket=synthetic",
                        ]
                        : ["artifact": artifact, "encoding": "base64", "data": Data("image".utf8).base64EncodedString()]
                default:
                    payload = ["ok": true]
                }
                let response = try JSONSerialization.data(withJSONObject: [
                    "type": "res", "id": id, "ok": true, "payload": payload,
                ])
                if requestedMethod == method ||
                    (holdObserverHides.value && requestedMethod == "sessions.observer.visibility" &&
                        params["visible"] as? Bool == false)
                {
                    heldRequest.setValue((socket, response))
                } else {
                    socket.emitReceiveSuccess(.data(response))
                }
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    mainSessionKey: "agent:main:main",
                    methods: [
                        "users.self",
                        "agents.list",
                        "sessions.list",
                        "chat.history",
                        "chat.send",
                        "sessions.patch",
                        "models.authLogin",
                    ],
                    capabilities: advertised))
            })
        }
        self.sockets = sockets
        self.gateway = GatewayConnection(
            testEndpointProvider: {
                .init(
                    config: (URL(string: "ws://127.0.0.1:49383")!, nil, nil),
                    routeAuthority: routeAuthority.value,
                    deviceAuthGatewayID: gatewayID)
            },
            sessionBox: WebSocketSessionBox(session: sockets))
    }

    var target: OpenClawNativeSessionRef {
        .init(
            owner: .init(gatewayID: self.gatewayID, profileID: self.profileID.value),
            agentID: "main",
            sessionKey: Self.sessionKey)
    }

    func frames(method: String) throws -> [[String: Any]] {
        try self.requests.value.map {
            try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
        }.filter { $0["method"] as? String == method }
    }

    func releaseRequest() {
        guard let (socket, response) = self.heldRequest.value else { return }
        socket.emitReceiveSuccess(.data(response))
        self.heldRequest.setValue(nil)
    }

    func rejectRequest(code: String, details: [String: String]? = nil) throws {
        let (socket, response) = try #require(self.heldRequest.value)
        let frame = try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])
        let id = try #require(frame["id"] as? String)
        var error: [String: Any] = ["code": code, "message": "Synthetic observer failure"]
        if let details { error["details"] = details }
        let rejection = try JSONSerialization.data(withJSONObject: [
            "type": "res", "id": id, "ok": false, "error": error,
        ])
        self.heldRequest.setValue((socket, rejection))
        self.releaseRequest()
    }

    private static var agents: [String: Any] {
        ["defaultId": "main", "mainKey": "main", "scope": "per-sender", "agents": [["id": "main"]]]
    }

    private static var session: [String: Any] {
        [
            "key": self.sessionKey, "agentId": "main", "sessionId": "native-session",
            "kind": "direct", "updatedAt": 1, "permissionMode": "guarded",
        ]
    }
}

extension NativeActionRouterTests {
    @Test(arguments: [nil, " profile-one ", "profile-e\u{301}", "profile-\u{E9}"] as [String?])
    func `model sign-in and catalog requests preserve native profile bytes and ordinary envelopes`(
        profileID: String?) async throws
    {
        try await self.withFixture { fixture, _, _ in
            fixture.capabilities.withValue { $0.append(GatewayServerCapability.publishedModelCatalog.rawValue) }
            if let profileID { fixture.profileID.setValue(profileID) }
            let lease = try await fixture.gateway.acquireServerLease()
            let binding = profileID.map { _ in
                MacGatewayChatTransport.NativeBinding(owner: fixture.target.owner, lease: lease)
            }
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway, defaultGlobalAgentID: "main", nativeBinding: binding)
            let context = try #require(await transport.acquireModelSignInContext(agentID: nil))
            #expect(context.agentID == "main")
            #expect(await context.isCurrent())
            let calls: [(String, [String: AnyCodable])] = [
                ("models.authStatus", ["agentId": AnyCodable(context.agentID)]),
                ("models.authLogin", [
                    "agentId": AnyCodable(context.agentID), "sessionId": AnyCodable("fixture-login"),
                    "authChoice": AnyCodable("fixture/device"),
                ]),
                ("wizard.next", ["sessionId": AnyCodable("fixture-login")]),
            ]
            for (method, params) in calls {
                _ = try await context.request(method, params)
            }
            let catalog = try await transport.loadModelCatalog(
                sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
            #expect(catalog.choices.map(\.modelID) == ["fixture-model"])
            #expect(catalog.availabilityIsSessionScoped)
            for method in calls.map(\.0) + ["models.list"] {
                let frames = try fixture.frames(method: method)
                try #require(frames.count == 1)
                let actual = frames[0]["expectedProfileId"] as? String
                #expect(actual.map { Array($0.utf8) } == profileID.map { Array($0.utf8) })
                #expect((frames[0]["params"] as? [String: Any])?["expectedProfileId"] == nil)
            }
            let catalogFrame = try #require(try fixture.frames(method: "models.list").first)
            let params = try #require(catalogFrame["params"] as? [String: Any])
            #expect(params["agentId"] as? String == "main")
            #expect(params["sessionKey"] as? String == MacNativeActionFixture.sessionKey)
            #expect(params["view"] as? String == "configured")
            #expect(params["includeDetails"] as? Bool == true)
            _ = try await context.closeWizard("fixture-login")
            let cleanup = try #require(try fixture.frames(method: "wizard.cancel").first)
            let cleanupParams = try #require(cleanup["params"] as? [String: Any])
            #expect(cleanup["expectedProfileId"] == nil)
            #expect(Set(cleanupParams.keys) == ["sessionId", "closeInput"])
            #expect(cleanupParams["sessionId"] as? String == "fixture-login")
            #expect(cleanupParams["closeInput"] as? Bool == true)
            #expect(fixture.sockets.snapshotMakeCount() == 1)
        }
    }

    @Test(arguments: ["models.authLogin", "models.list"])
    func `model profile rejection retires fresh actions but retains cleanup on the original socket`(
        rejectedMethod: String) async throws
    {
        try await self.withFixture { fixture, _, _ in
            fixture.capabilities.withValue { $0.append(GatewayServerCapability.publishedModelCatalog.rawValue) }
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                defaultGlobalAgentID: "main",
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            let context = try #require(await transport.acquireModelSignInContext(agentID: nil))
            fixture.profileID.setValue("replacement-profile")
            if rejectedMethod == "models.list" {
                await #expect(throws: GatewayResponseError.self) {
                    _ = try await transport.loadModelCatalog(
                        sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
                }
            } else {
                await #expect(throws: GatewayResponseError.self) {
                    _ = try await context.request(rejectedMethod, [
                        "agentId": AnyCodable("main"), "sessionId": AnyCodable("fixture-login"),
                        "authChoice": AnyCodable("fixture/device"),
                    ])
                }
            }
            #expect(fixture.profileRejections.value.count == 1)
            #expect(!transport.nativeBindingIsCurrent)
            #expect(await context.isCurrent() == false)
            #expect(await transport.acquireModelSignInContext(agentID: "main") == nil)
            let requestCount = fixture.requests.value.count
            for method in ["models.authStatus", "models.authLogin", "wizard.next"] {
                await #expect(throws: OpenClawChatTransportSendError.self) {
                    _ = try await context.request(method, ["sessionId": AnyCodable("fixture-login")])
                }
            }
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await transport.loadModelCatalog(
                    sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
            }
            #expect(fixture.requests.value.count == requestCount)
            #expect(await fixture.gateway.isCurrentServerLease(lease))
            _ = try await context.closeWizard("fixture-login")
            let cleanup = try #require(try fixture.frames(method: "wizard.cancel").first)
            #expect(cleanup["expectedProfileId"] == nil)
            #expect((cleanup["params"] as? [String: Any])?["sessionId"] as? String == "fixture-login")
            #expect((cleanup["params"] as? [String: Any])?["closeInput"] as? Bool == true)
            #expect(fixture.requests.value.count == requestCount + 1)
            #expect(fixture.sockets.snapshotMakeCount() == 1)
            #expect(fixture.profileRejections.value.count == 1)
        }
    }

    @Test(arguments: [false, true])
    func `retired model actions cannot reconnect or use a replacement but fresh ordinary catalog can`(
        reconnectFirst: Bool) async throws
    {
        try await self.withFixture { fixture, _, _ in
            fixture.capabilities.withValue { $0.append(GatewayServerCapability.publishedModelCatalog.rawValue) }
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                defaultGlobalAgentID: "main",
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            let context = try #require(await transport.acquireModelSignInContext(agentID: nil))
            await fixture.gateway.shutdown()
            if reconnectFirst {
                let replacement = try await fixture.gateway.acquireServerLease()
                #expect(replacement != lease)
            }
            let requestCount = fixture.requests.value.count
            let socketCount = fixture.sockets.snapshotMakeCount()
            #expect(await context.isCurrent() == false)
            #expect(await transport.acquireModelSignInContext(agentID: "main") == nil)
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await context.closeWizard("original-login")
            }
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await context.request("models.authLogin", [
                    "agentId": AnyCodable("main"), "sessionId": AnyCodable("stale-login"),
                    "authChoice": AnyCodable("fixture/device"),
                ])
            }
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await transport.loadModelCatalog(
                    sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
            }
            #expect(fixture.requests.value.count == requestCount)
            #expect(fixture.sockets.snapshotMakeCount() == socketCount)
            #expect(try fixture.frames(method: "wizard.cancel").isEmpty)

            let ordinary = MacGatewayChatTransport(connection: fixture.gateway, defaultGlobalAgentID: "main")
            let catalog = try await ordinary.loadModelCatalog(
                sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
            #expect(catalog.choices.map(\.modelID) == ["fixture-model"])
            #expect(fixture.sockets.snapshotMakeCount() == 2)
            let fresh = try #require(await ordinary.acquireModelSignInContext(agentID: nil))
            #expect(await fresh.isCurrent())
            _ = try await fresh.request("models.authStatus", ["agentId": AnyCodable("main")])
            #expect(try fixture.frames(method: "models.list").last?["expectedProfileId"] == nil)
            #expect(try fixture.frames(method: "models.authStatus").last?["expectedProfileId"] == nil)
        }
    }

    @Test(arguments: [false, true])
    func `model catalog requires its published capability for native and ordinary transports`(
        native: Bool) async throws
    {
        try await self.withFixture { fixture, _, _ in
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: native ? .init(owner: fixture.target.owner, lease: lease) : nil)
            let catalog = try await transport.loadModelCatalog(
                sessionKey: MacNativeActionFixture.sessionKey, agentID: "main")
            #expect(catalog.choices.isEmpty)
            #expect(!catalog.availabilityIsSessionScoped)
            #expect(try fixture.frames(method: "models.list").isEmpty)
            #expect(try fixture.frames(method: "health").count == (native ? 1 : 2))
        }
    }
}

@Suite(.serialized)
@MainActor
struct NativeActionRouterTests {
    @Test func `cold catalog acquisition uses the logical gateway and canonical profile`() async throws {
        try await self.withFixture { fixture, _, router in
            #expect(await fixture.gateway.connectionSummary().connected == false)
            let choices = try await router.sessions(matching: nil)
            #expect(choices.map(\.session) == [fixture.target])
            #expect(choices.first?.session.owner.gatewayID != MacChatTranscriptCache.currentGatewayID())
            #expect(try fixture.frames(method: "users.self").count == 1)
            #expect(try fixture.frames(method: "health").count == 1)
            #expect(try fixture.frames(method: "sessions.list").first?["expectedProfileId"] as? String ==
                fixture.profileID.value)
        }
    }

    @Test(arguments: [false, true])
    func `native submission uses negotiated CAS without enabling the Mac composer catalog`(
        supportsCAS: Bool) async throws
    {
        try await self.withFixture { fixture, manager, router in
            if !supportsCAS {
                fixture.capabilities
                    .withValue { $0.removeAll { $0 == GatewayServerCapability.sessionSettingsCAS.rawValue } }
            }
            let prepared = try await router.prepareSend(to: fixture.target, message: "same message")
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let controller = try manager.presentNative(.session(fixture.target), gateway: gateway)
            #expect(controller.gatewayTransport?.supportsComposerCapabilities == false)
            let reply = OpenClawChatReplyTarget(messageID: UUID(), text: "kept", senderLabel: "User")
            controller.viewModel.input = "same message"
            controller.viewModel.replyTarget = reply
            if supportsCAS {
                let run = try await prepared.submit()
                #expect(run == OpenClawNativeRunRef(session: fixture.target, runID: "gateway-accepted-run"))
                let frames = try fixture.frames(method: "chat.send")
                try #require(frames.count == 1)
                let params = try #require(frames[0]["params"] as? [String: Any])
                #expect(frames[0]["expectedProfileId"] as? String == fixture.profileID.value)
                #expect(params["expectedPermissionMode"] as? String == "guarded")
                #expect(params["expectedToolOverrides"] is NSNull)
            } else {
                await #expect(throws: Error.self) { _ = try await prepared.submit() }
                #expect(try fixture.frames(method: "chat.send").isEmpty)
            }
            #expect(controller.viewModel.input == "same message")
            #expect(controller.viewModel.replyTarget == reply)
        }
    }

    @Test(arguments: [false, true])
    func `cold primary acquisition cannot outlive cancellation or its window generation`(
        cancel: Bool) async throws
    {
        try await self.withFixture(holding: "health") { fixture, manager, _ in
            let pending = Task { try await manager.captureNativeGateway(gatewayID: fixture.gatewayID) }
            do {
                let deadline = ContinuousClock.now + .seconds(3)
                while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(fixture.heldRequest.value != nil)
                if cancel { pending.cancel() } else { manager.resetPrimaryConnections() }
                fixture.releaseRequest()
                await #expect(throws: CancellationError.self) { _ = try await pending.value }
                #expect(manager.activeSessionKey == nil)
            } catch {
                fixture.releaseRequest()
                _ = try? await pending.value
                throw error
            }
        }
    }

    @Test func `cold saved gateway acquisition reaches its owner without opening a window`() async throws {
        try await withIsolatedWebChatManager { manager in
            var requested = false
            let server = try await DashboardHTTPFixture.start(beforeResponse: { requested = true })
            defer { server.stop() }
            let store = MacGatewayProfileStore.shared
            let attempt = try await store.beginBrowserSignIn(url: server.websocketURL("/native-cold"))
            let profile = try await store.saveConnection(
                name: "Native cold fixture", token: nil, password: nil, attempt: attempt)
            #expect(await MacGatewayConnectionFleet.shared.existingConnection(profileID: profile.id) == nil)
            // This HTTP-only fixture rejects the upgrade. Reaching it proves
            // the action used normal binding/connection instead of requiring a window.
            await #expect(throws: Error.self) {
                _ = try await manager.captureNativeGateway(gatewayID: profile.id)
            }
            #expect(requested)
            #expect(manager.openWindowCount(profileID: profile.id) == 0)
            try await store.remove(profileID: profile.id)
        }
    }

    @Test func `a different canonical profile cannot open the selected session`() async throws {
        try await self.withFixture { fixture, manager, router in
            let target = OpenClawNativeSessionRef(
                owner: .init(gatewayID: fixture.gatewayID, profileID: "another-profile"),
                agentID: fixture.target.agentID,
                sessionKey: fixture.target.sessionKey)
            guard case .unavailable = await router.open(.session(target)) else {
                Issue.record("A foreign account selection opened a chat")
                return
            }
            #expect(manager.activeSessionKey == nil)
            let historyFrames = try fixture.frames(method: "chat.history")
            #expect(historyFrames.isEmpty)
            let sendFrames = try fixture.frames(method: "chat.send")
            #expect(sendFrames.isEmpty)
        }
    }

    @Test func `preparing reuses the selected VM without consuming its composer or reply`() async throws {
        try await self.withFixture { fixture, manager, router in
            #expect(await router.open(.session(fixture.target)) == .opened)
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let controller = try manager.presentNative(.session(fixture.target), gateway: gateway)
            let reply = OpenClawChatReplyTarget(messageID: UUID(), text: "kept", senderLabel: "User")
            controller.viewModel.input = "same message"
            controller.viewModel.replyTarget = reply

            let prepared = try await router.prepareSend(to: fixture.target, message: "same message")
            let reopened = try manager.presentNative(.session(fixture.target), gateway: gateway)
            #expect(reopened === controller)
            #expect(controller.gatewayTransport?.outboxGatewayID == nil)
            #expect(controller.viewModel.transcriptCache == nil)
            #expect(controller.viewModel.outbox == nil)
            #expect(prepared.session == fixture.target)
            #expect(controller.viewModel.input == "same message")
            #expect(controller.viewModel.replyTarget == reply)
            #expect(try fixture.frames(method: "chat.send").isEmpty)
        }
    }

    @Test(arguments: ["selected-run", "other-run", "other-session"])
    func `inspection returns only the selected run facts and opens its verified chat`(
        _ historyOwner: String) async throws
    {
        try await self.withFixture { fixture, manager, router in
            let run = OpenClawNativeRunRef(session: fixture.target, runID: "selected-run")
            fixture.historySessionInfo.setValue([
                "key": historyOwner == "other-session" ? "agent:main:other" : run.session.sessionKey,
                "agentId": run.session.agentID, "lastRunId": historyOwner, "status": "done",
            ])
            if historyOwner == "other-session" {
                await #expect(throws: OpenClawNativeActionError.self) { _ = try await router.inspect(run) }
                let context = try #require(manager.approvalContext(connection: fixture.gateway))
                #expect(context.sessionKey == nil)
                #expect(context.agentID == nil)
                #expect(context.windowID == nil)
                #expect(context.nativeBinding == nil)
                #expect(!manager._testSessionObserverVisible(connection: fixture.gateway))
            } else {
                enum Stage: String { case inspect, capture, present }
                var stage = Stage.inspect
                var capturedLease: GatewayConnection.ServerLease?
                do {
                    let inspection = try await router.inspect(run)
                    #expect(inspection.run == run)
                    #expect(inspection.association == (historyOwner == run.runID ? .observed : .notObserved))
                    #expect(inspection.outcome == (historyOwner == run.runID ? .done : nil))
                    #expect(!inspection.summary.isEmpty)
                    stage = .capture
                    let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
                    capturedLease = gateway.lease
                    stage = .present
                    let controller = try manager.presentNative(.inspect(run), gateway: gateway)
                    #expect(controller.hasPresentedNative(.inspect(run)))
                    #expect(!controller.viewModel.isLoading)
                    #expect(controller.viewModel.healthOK)
                    #expect(controller._testWindow?.attachedSheet == nil)
                } catch {
                    let socket = fixture.sockets.latestTask()
                    let controllers = NSApp.windows.compactMap { $0.delegate as? WebChatSwiftUIWindowController }
                        .filter { $0.gatewayTransport?.connection === fixture.gateway }
                    let controller = controllers.count == 1 ? controllers.first : nil
                    let bindingCurrent = controller?.gatewayTransport?.nativeBindingIsCurrent
                    let lease = capturedLease ?? controller?.gatewayTransport?.nativeBinding?.lease
                    let leaseCurrent = lease.map { fixture.gateway.serverLeaseMatchesCurrentState($0) }
                    func fact(_ value: Bool?) -> String {
                        value.map(String.init) ?? "unknown"
                    }
                    print([
                        "native inspection failed: case=\(historyOwner); stage=\(stage.rawValue)",
                        "taskCancelled=\(Task.isCancelled)",
                        "socketMakes=\(fixture.sockets.snapshotMakeCount())",
                        "socketCancels=\(fixture.sockets.snapshotCancelCount())",
                        "socketRunning=\(fact(socket.map { $0.state == .running }))",
                        "windowCount=\(controllers.count)",
                        "windowVisible=\(fact(controller?.isVisible))",
                        "nativeSessionMatches=\(fact(controller.map { $0.matchesNativeSession(run.session) }))",
                        "bindingCurrent=\(fact(bindingCurrent))",
                        "leaseStateMatches=\(fact(leaseCurrent))",
                    ].joined(separator: "; "))
                    throw error
                }
            }
            let history = try #require(try fixture.frames(method: "chat.history").first)
            let params = try #require(history["params"] as? [String: Any])
            #expect(history["expectedProfileId"] as? String == run.session.owner.profileID)
            #expect(params["sessionKey"] as? String == run.session.sessionKey)
            #expect(params["inputRunIds"] as? [String] == [run.runID])
            #expect(try fixture.frames(method: "chat.send").isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `inspect continuation never reports opened while its chat is unhealthy or still loading`(
        holdHistory: Bool) async throws
    {
        try await self.withFixture(holding: holdHistory ? "chat.history" : nil) { fixture, _, router in
            fixture.healthOK.setValue(holdHistory)
            let run = OpenClawNativeRunRef(session: fixture.target, runID: "selected-run")
            let pending = Task { await router.open(.inspect(run)) }
            do {
                if holdHistory {
                    _ = try await self.waitForObserverFrames(
                        fixture, method: "chat.history", count: 1, holdingResponse: true)
                    fixture.releaseRequest()
                    // Run validation completes, but the visible chat's own
                    // bootstrap must not be bypassed by the inspect continuation.
                    _ = try await self.waitForObserverFrames(
                        fixture, method: "chat.history", count: 2, holdingResponse: true)
                }
                guard case .unavailable = await pending.value else {
                    Issue.record("Inspection acknowledged a chat before it was ready")
                    fixture.releaseRequest()
                    return
                }
                fixture.releaseRequest()
            } catch {
                pending.cancel()
                fixture.releaseRequest()
                _ = await pending.value
                throw error
            }
        }
    }

    @Test func `native open preserves an already warm ordinary window and its draft`() async throws {
        try await self.withFixture { fixture, manager, router in
            let ordinary = try self.showOrdinaryWindow(manager, fixture: fixture, draft: "ordinary draft")
            let ordinaryContext = try #require(manager.approvalContext(connection: fixture.gateway))
            let ordinaryWindow = try #require(ordinary._testWindow)
            #expect(ordinaryContext.windowID == ObjectIdentifier(ordinary))
            #expect(ordinaryContext.nativeBinding == nil)
            #expect(await router.open(.session(fixture.target)) == .opened)
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let native = try manager.presentNative(.session(fixture.target), gateway: gateway)
            #expect(ObjectIdentifier(native) != ordinaryContext.windowID)
            #expect(native.gatewayTransport?.nativeBinding?.owner == fixture.target.owner)
            #expect(native.gatewayTransport?.connection === fixture.gateway)
            #expect(ordinaryWindow.isVisible)
            native.close()
            manager.show(sessionKey: MacNativeActionFixture.sessionKey, agentID: "main", draft: "replacement")
            #expect(ordinaryWindow.isVisible)
            #expect(ordinary._testWindow === ordinaryWindow)
            #expect(manager.approvalContext(connection: fixture.gateway)?.windowID == ObjectIdentifier(ordinary))
            #expect(ordinary.viewModel.input == "ordinary draft")
        }
    }

    @Test func `old gateway without profile binding is visibly unavailable before catalog reads`() async throws {
        try await self.withFixture { fixture, _, router in
            fixture.capabilities.withValue { $0.removeAll { $0 == GatewayServerCapability.profileBinding.rawValue } }
            await #expect(throws: OpenClawNativeActionError.self) { _ = try await router.sessions(matching: nil) }
            let selfFrames = try fixture.frames(method: "users.self")
            #expect(selfFrames.isEmpty)
            let sessionFrames = try fixture.frames(method: "sessions.list")
            #expect(sessionFrames.isEmpty)
        }
    }

    @Test(arguments: [false, true])
    func `a retired visible window cannot prevent its replacement from observing sessions`(
        ordinaryReplacement: Bool) async throws
    {
        try await self.withFixture { fixture, manager, _ in
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let retired = try manager.presentNative(.session(fixture.target), gateway: gateway)
            _ = try await self.waitForObserverFrames(fixture, count: 1)
            retired.gatewayTransport?.reportNativeRouteUnavailable()
            fixture.profileID.setValue("replacement-profile")

            let replacement: WebChatSwiftUIWindowController
            if ordinaryReplacement {
                replacement = try self.showOrdinaryWindow(manager, fixture: fixture, draft: "kept")
            } else {
                replacement = try manager.presentNative(.session(fixture.target), gateway: gateway)
            }
            // Keep the retired controller first in the activation order, not just
            // in a favorable dictionary order, while the replacement reconciles.
            retired.show()
            let visible = try await self.waitForObserverFrames(fixture, count: 2)
            let expectedProfile = ordinaryReplacement ? nil : fixture.profileID.value
            #expect(retired.isVisible)
            #expect(retired.nativeRouteLost)
            #expect(replacement.isVisible)
            #expect(replacement !== retired)
            #expect(visible.last?["expectedProfileId"] as? String == expectedProfile)
            let subscriptions = try fixture.frames(method: "sessions.subscribe")
            #expect(subscriptions.count == 2)
            #expect(subscriptions.last?["expectedProfileId"] as? String == expectedProfile)

            replacement.show()
            retired.close()
            if ordinaryReplacement { #expect(replacement.viewModel.input == "kept") }
            replacement.close()
            let final = try await self.waitForObserverFrames(fixture, count: 3)
            #expect(final.compactMap { ($0["params"] as? [String: Any])?["visible"] as? Bool } ==
                [true, true, false])
            #expect(final.last?["expectedProfileId"] as? String == expectedProfile)
            #expect(try fixture.frames(method: "sessions.subscribe").count == 2)
            #expect(!manager._testSessionObserverVisible(connection: fixture.gateway))
        }
    }

    @Test(arguments: [false, true])
    func `a subscription awaiting acknowledgement cannot publish a retired window owner`(
        rejectedAcknowledgement: Bool) async throws
    {
        try await self.withFixture(holding: "sessions.subscribe") { fixture, manager, _ in
            defer { fixture.releaseRequest() }
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let retired = try manager.presentNative(.session(fixture.target), gateway: gateway)
            _ = try await self.waitForObserverFrames(
                fixture, method: "sessions.subscribe", count: 1, holdingResponse: true)
            try #require(fixture.heldRequest.value != nil)
            if rejectedAcknowledgement {
                try fixture.rejectRequest(
                    code: "INVALID_REQUEST",
                    details: ["reason": "EXPECTED_PROFILE_MISMATCH", "execution": "may_have_executed"])
                // Only this response reports loss; another RPC or push must not
                // supply the retirement that the observer owner is responsible for.
                let deadline = ContinuousClock.now + .seconds(3)
                while !retired.viewModel.isTransportDetached, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(retired.viewModel.isTransportDetached)
                #expect(retired.nativeRouteLost)
                #expect(!retired.viewModel.healthOK)
                #expect(retired.viewModel.errorText?.isEmpty == false)
                #expect(try fixture.frames(method: "sessions.observer.visibility").isEmpty)
            } else {
                retired.gatewayTransport?.reportNativeRouteUnavailable()
            }
            fixture.profileID.setValue("replacement-profile")
            let replacement = try manager.presentNative(.session(fixture.target), gateway: gateway)
            retired.show()
            if !rejectedAcknowledgement { fixture.releaseRequest() }

            let subscriptions = try await self.waitForObserverFrames(
                fixture, method: "sessions.subscribe", count: 2, holdingResponse: true)
            try #require(fixture.heldRequest.value != nil)
            fixture.releaseRequest()
            let visible = try await self.waitForObserverFrames(fixture, count: 1)
            #expect(subscriptions.compactMap { $0["expectedProfileId"] as? String } ==
                ["profile-one", "replacement-profile"])
            #expect(visible.count == 1)
            #expect(visible.first?["expectedProfileId"] as? String == "replacement-profile")
            #expect(retired.isVisible)
            #expect(replacement.isVisible)
            #expect(!replacement.nativeRouteLost)
            #expect(!replacement.viewModel.isTransportDetached)
        }
    }

    @Test(arguments: ["pending", "failed", "profile-change", "ordinary"])
    func `last window cleanup retains its binding without a confirmed observer declaration`(
        _ scenario: String) async throws
    {
        try await self.withFixture(holding: "sessions.subscribe") { fixture, manager, _ in
            defer { fixture.releaseRequest() }
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let expectedProfile = scenario == "ordinary" ? nil : fixture.profileID.value
            let controller: WebChatSwiftUIWindowController
            if scenario == "ordinary" {
                controller = try self.showOrdinaryWindow(manager, fixture: fixture)
            } else {
                controller = try manager.presentNative(.session(fixture.target), gateway: gateway)
            }
            _ = try await self.waitForObserverFrames(
                fixture, method: "sessions.subscribe", count: 1, holdingResponse: true)
            if scenario == "failed" {
                try fixture.rejectRequest(
                    code: "INVALID_REQUEST",
                    details: ["reason": "EXPECTED_PROFILE_MISMATCH", "execution": "not_started"])
                let deadline = ContinuousClock.now + .seconds(3)
                while !controller.viewModel.isTransportDetached, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(controller.viewModel.isTransportDetached)
            }
            if scenario == "profile-change" || scenario == "ordinary" {
                fixture.profileID.setValue("replacement-profile")
            }
            if scenario != "ordinary" {
                controller.gatewayTransport?.reportNativeRouteUnavailable()
                try #require(controller.nativeRouteLost)
            }
            controller.close()
            fixture.releaseRequest()
            let hides = try await self.waitForObserverFrames(
                fixture, count: scenario == "profile-change" ? 2 : 1)
            #expect(hides.allSatisfy {
                ($0["params"] as? [String: Any])?["visible"] as? Bool == false &&
                    $0["expectedProfileId"] as? String == expectedProfile
            })
            #expect(await fixture.gateway.isCurrentServerLease(gateway.lease))
            #expect(!manager._testSessionObserverVisible(connection: fixture.gateway))
            #expect(try fixture.frames(method: "sessions.subscribe").count == 1)
            if scenario == "profile-change" {
                #expect(fixture.profileRejections.value == hides.compactMap { $0["id"] as? String })
            }
        }
    }

    @Test(arguments: ["native", "profile-change", "ordinary"])
    func `a final hidden retry retains its original lease and optional account`(_ scenario: String) async throws {
        try await self.withFixture { fixture, manager, _ in
            defer { fixture.releaseRequest() }
            let gateway = try await manager.captureNativeGateway(gatewayID: fixture.gatewayID)
            let expectedProfile = scenario == "ordinary" ? nil : fixture.profileID.value
            let controller: WebChatSwiftUIWindowController
            if scenario == "ordinary" {
                controller = try self.showOrdinaryWindow(manager, fixture: fixture)
            } else {
                controller = try manager.presentNative(.session(fixture.target), gateway: gateway)
            }
            _ = try await self.waitForObserverFrames(fixture, count: 1)
            fixture.holdObserverHides.setValue(true)
            controller.close()
            let first = try await self.waitForObserverFrames(fixture, count: 2, holdingResponse: true)
            try #require(first.last?["expectedProfileId"] as? String == expectedProfile)
            try #require(await fixture.gateway.isCurrentServerLease(gateway.lease))
            #expect(!manager._testSessionObserverVisible(connection: fixture.gateway))

            if scenario != "native" { fixture.profileID.setValue("replacement-profile") }
            try fixture.rejectRequest(code: "UNAVAILABLE")
            let frames = try await self.waitForObserverFrames(
                fixture, count: 3, holdingResponse: scenario != "profile-change")
            #expect(frames.compactMap { ($0["params"] as? [String: Any])?["visible"] as? Bool } ==
                [true, false, false])
            #expect(frames.allSatisfy {
                ($0["expectedProfileId"] as? String).map { Array($0.utf8) } ==
                    expectedProfile.map { Array($0.utf8) }
            })
            #expect(await fixture.gateway.isCurrentServerLease(gateway.lease))
            if scenario == "profile-change" {
                let rejectedID = try #require(frames.last?["id"] as? String)
                let deadline = ContinuousClock.now + .seconds(3)
                while !fixture.profileRejections.value.contains(rejectedID), ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                let observerIDs = frames.compactMap { $0["id"] as? String }
                #expect(fixture.profileRejections.value.filter { observerIDs.contains($0) } == [rejectedID])
                #expect(fixture.heldRequest.value == nil)
            } else {
                let (_, response) = try #require(fixture.heldRequest.value)
                let frame = try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])
                #expect(frame["ok"] as? Bool == true)
                #expect(fixture.profileRejections.value.isEmpty)
                fixture.releaseRequest()
            }
            #expect(!manager._testSessionObserverVisible(connection: fixture.gateway))
            #expect(try fixture.frames(method: "sessions.subscribe").count == 1)
        }
    }

    @Test(arguments: ["reconnect", "window close", "profile change"])
    func `prepared send cannot replace its original connection window or account`(_ retirement: String) async throws {
        try await self.withFixture { fixture, manager, router in
            let prepared = try await router.prepareSend(to: fixture.target, message: "native message")
            switch retirement {
            case "reconnect":
                await fixture.gateway.shutdown()
                _ = try await fixture.gateway.request(method: "health", params: nil)
            case "window close":
                manager.resetPrimaryConnections()
            default:
                fixture.profileID.setValue("replacement-profile")
            }
            await #expect(throws: Error.self) {
                _ = try await prepared.submit()
            }
            #expect(try fixture.frames(method: "chat.send").isEmpty)
        }
    }

    @Test(arguments: ["same-owner", "unbound", "byte-distinct"])
    func `widget refresh shares only its exact owner and serializes other owners`(_ scenario: String) async throws {
        let fixture = try MacNativeActionFixture(holding: "plugin.surface.refresh")
        let firstProfile = scenario == "byte-distinct" ? "\u{E9}" : "profile-one"
        let secondProfile: String? = switch scenario {
        case "unbound": nil
        case "byte-distinct": "e\u{301}"
        default: firstProfile
        }
        fixture.profileID.setValue(firstProfile)
        var pending: [Task<GatewayCanvasHostRoute?, Error>] = []
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let observed = "http://127.0.0.1:49383/__openclaw__/cap/original"
            let first = Task {
                try await fixture.gateway.refreshCanvasPluginSurfaceRoute(
                    replacing: observed, ifCurrentServerLease: lease, expectedProfileId: firstProfile)
            }
            pending.append(first)
            try await self.waitForHeldWidgetRefresh(fixture)
            let secondValidations = LockIsolated(0)
            let second = Task {
                try await fixture.gateway.refreshCanvasPluginSurfaceRoute(
                    replacing: observed,
                    ifCurrentServerLease: lease,
                    expectedProfileId: secondProfile,
                    isCurrent: {
                        secondValidations.withValue { $0 += 1 }
                        return true
                    })
            }
            pending.append(second)
            let deadline = ContinuousClock.now + .seconds(3)
            while secondValidations.value < 2, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(secondValidations.value >= 2)
            #expect(try fixture.frames(method: "plugin.surface.refresh").count == 1)
            fixture.releaseRequest()
            let firstRoute = try #require(try await first.value)
            if scenario == "unbound" {
                try await self.waitForHeldWidgetRefresh(fixture)
                fixture.releaseRequest()
            }
            let secondRoute: GatewayCanvasHostRoute?
            if scenario == "byte-distinct" {
                await #expect(throws: GatewayResponseError.self) { _ = try await second.value }
                secondRoute = nil
            } else {
                secondRoute = try #require(try await second.value)
            }
            let frames = try fixture.frames(method: "plugin.surface.refresh")
            #expect(frames.count == (scenario == "same-owner" ? 1 : 2))
            #expect(frames.allSatisfy { ($0["params"] as? [String: Any])?["observedUrl"] as? String == observed })
            if scenario == "same-owner" {
                #expect(firstRoute == secondRoute)
            } else {
                let actual = frames.last?["expectedProfileId"] as? String
                #expect(actual.map { Array($0.utf8) } == secondProfile.map { Array($0.utf8) })
                if scenario == "unbound" {
                    #expect(firstRoute.url != secondRoute?.url)
                }
                #expect(try await fixture.gateway.canvasPluginSurfaceRoute(
                    ifCurrentServerLease: lease,
                    expectedProfileId: firstProfile,
                    isCurrent: { true }) == (scenario == "byte-distinct" ? firstRoute : nil))
            }
            #expect(try await fixture.gateway.canvasPluginSurfaceRoute(
                ifCurrentServerLease: lease,
                expectedProfileId: secondProfile,
                isCurrent: { true }) == secondRoute)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            for task in pending {
                _ = await task.result
            }
            throw error
        }
        fixture.releaseRequest()
        await fixture.gateway.shutdown()
    }

    @Test func `reset widget refresh cannot publish its late result or retire the next refresh`() async throws {
        let fixture = try MacNativeActionFixture(holding: "plugin.surface.refresh")
        var pending: [Task<GatewayCanvasHostRoute?, Error>] = []
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let profile = fixture.target.owner.profileID
            let stale = Task {
                try await fixture.gateway.refreshCanvasPluginSurfaceRoute(
                    replacing: nil, ifCurrentServerLease: lease, expectedProfileId: profile)
            }
            pending.append(stale)
            try await self.waitForHeldWidgetRefresh(fixture)
            await fixture.gateway.resetCanvasPluginSurfaceState()
            fixture.releaseRequest()
            let replacement = Task {
                try await fixture.gateway.refreshCanvasPluginSurfaceRoute(
                    replacing: nil, ifCurrentServerLease: lease, expectedProfileId: profile)
            }
            pending.append(replacement)
            await #expect(throws: Error.self) { _ = try await stale.value }
            try await self.waitForHeldWidgetRefresh(fixture)
            fixture.releaseRequest()
            let route = try #require(try await replacement.value)
            #expect(try fixture.frames(method: "plugin.surface.refresh").count == 2)
            #expect(try await fixture.gateway.canvasPluginSurfaceRoute(
                ifCurrentServerLease: lease,
                expectedProfileId: profile,
                isCurrent: { true }) == route)
            await fixture.gateway.shutdown()
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await fixture.gateway.refreshCanvasPluginSurfaceRoute(
                    replacing: nil, ifCurrentServerLease: lease, expectedProfileId: profile)
            }
            #expect(try fixture.frames(method: "plugin.surface.refresh").count == 2)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            for task in pending {
                _ = await task.result
            }
            throw error
        }
        fixture.releaseRequest()
        await fixture.gateway.shutdown()
    }

    private func showOrdinaryWindow(
        _ manager: WebChatManager,
        fixture: MacNativeActionFixture,
        draft: String? = nil) throws -> WebChatSwiftUIWindowController
    {
        // Capture the synchronous presentation owner; headless runs need not grant app focus.
        let previousWindows = Set(NSApp.windows.map(ObjectIdentifier.init))
        manager.show(sessionKey: MacNativeActionFixture.sessionKey, agentID: "main", draft: draft)
        let controllers = NSApp.windows
            .filter { !previousWindows.contains(ObjectIdentifier($0)) }
            .compactMap { $0.delegate as? WebChatSwiftUIWindowController }
        try #require(controllers.count == 1)
        let controller = try #require(controllers.first)
        let transport = try #require(controller.gatewayTransport)
        try #require(transport.connection === fixture.gateway)
        try #require(transport.nativeBinding == nil)
        return controller
    }

    private func waitForHeldWidgetRefresh(_ fixture: MacNativeActionFixture) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(fixture.heldRequest.value != nil)
    }

    private func waitForObserverFrames(
        _ fixture: MacNativeActionFixture,
        method: String = "sessions.observer.visibility",
        count: Int,
        holdingResponse: Bool = false) async throws -> [[String: Any]]
    {
        let deadline = ContinuousClock.now + .seconds(3)
        while try fixture.frames(method: method).count < count ||
            (holdingResponse && fixture.heldRequest.value == nil),
            ContinuousClock.now < deadline
        {
            try await Task.sleep(for: .milliseconds(10))
        }
        let frames = try fixture.frames(method: method)
        try #require(frames.count == count)
        return frames
    }

    private func withFixture(
        holding method: String? = nil,
        _ body: (MacNativeActionFixture, WebChatManager, NativeActionRouter) async throws -> Void) async throws
    {
        let fixture = try MacNativeActionFixture(holding: method)
        let path = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: path) }
        do {
            try await withIsolatedWebChatManager(
                primaryConnection: fixture.gateway, env: ["OPENCLAW_CONFIG_PATH": path])
            { manager in
                try JSONSerialization.data(withJSONObject: MacNativeActionFixture.configuration)
                    .write(to: URL(fileURLWithPath: path))
                try await body(fixture, manager, NativeActionRouter(
                    windows: manager, launchPlan: .init(arguments: ["OpenClaw"])))
            }
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }
}
