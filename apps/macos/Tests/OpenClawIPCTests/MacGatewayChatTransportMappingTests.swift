import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct MacGatewayChatTransportMappingTests {
    @Test func `native widgets acquire their initial surface and retire on a profile mismatch`() async throws {
        let fixture = try MacNativeActionFixture()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let owner = fixture.target.owner
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: .init(owner: owner, lease: lease))
            let path = "/__openclaw__/canvas/documents/native.html"
            let resource = try #require(await transport.resolveInlineWidgetResource(path: path, replacing: nil))
            #expect(resource.url.path.contains("/cap/rotation-"))
            #expect(try fixture.frames(method: "plugin.surface.refresh").count == 1)
            fixture.profileID.setValue("another-profile")
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: resource) == nil)
            #expect(!transport.nativeBindingIsCurrent)
            let frames = try fixture.frames(method: "plugin.surface.refresh")
            #expect(frames.count == 2)
            #expect(frames.allSatisfy { $0["expectedProfileId"] as? String == owner.profileID })
            #expect(await transport.resolveInlineWidgetResource(path: path, replacing: nil) == nil)
            #expect(try fixture.frames(method: "plugin.surface.refresh").count == 2)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `binding loss terminates the native event stream and prevents later RPCs`(
        mismatchedRecipient: Bool) async throws
    {
        let fixture = try MacNativeActionFixture()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            var events = transport.events().makeAsyncIterator()
            guard case .health(ok: true) = await events.next() else {
                Issue.record("Expected the profile-bound initial health response")
                await fixture.gateway.shutdown()
                return
            }
            if mismatchedRecipient {
                let frame = try JSONDecoder().decode(EventFrame.self, from: JSONSerialization.data(withJSONObject: [
                    "type": "event", "event": "tick", "seq": 1, "recipientProfileId": "other-profile",
                ]))
                await fixture.gateway._test_handlePush(.event(frame), socketGeneration: lease.socketGeneration)
            } else {
                fixture.profileID.setValue("other-profile")
                await #expect(throws: GatewayResponseError.self) {
                    _ = try await transport.requestHistory(sessionKey: fixture.target.sessionKey)
                }
            }
            guard case let .routeUnavailable(reason) = await events.next() else {
                Issue.record("Missing terminal native-route loss")
                await fixture.gateway.shutdown()
                return
            }
            #expect(!reason.isEmpty)
            #expect(await events.next() == nil)
            #expect(!transport.nativeBindingIsCurrent)
            #expect(await fixture.gateway.isCurrentServerLease(lease))
            fixture.profileID.setValue(fixture.target.owner.profileID)
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await transport.requestHistory(sessionKey: fixture.target.sessionKey)
            }
            #expect(try fixture.frames(method: "chat.history").count == (mismatchedRecipient ? 0 : 1))
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `native lease cannot borrow routing evidence from a replacement socket`() async throws {
        let fixture = try MacNativeActionFixture(holding: "agents.list")
        var pending: Task<OpenClawChatTransportRouteLeaseResult, Never>?
        do {
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let original = try #require(await fixture.gateway.captureServerLease())
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: .init(owner: fixture.target.owner, lease: original))
            let acquisition = Task { await transport.acquireOutboxRouteLease(ifCurrentServerLease: original) }
            pending = acquisition
            let deadline = ContinuousClock.now + .seconds(3)
            while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(fixture.heldRequest.value != nil)
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let replacement = try #require(await fixture.gateway.captureServerLease())
            #expect(original != replacement)
            fixture.releaseRequest()
            guard case .unavailable = await acquisition.value else {
                Issue.record("A retired physical socket produced a send lease")
                await fixture.gateway.shutdown()
                return
            }
            #expect(try fixture.frames(method: "agents.list").count == 1)
            #expect(try fixture.frames(method: "chat.send").isEmpty)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            _ = await pending?.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `captured transport preserves canonical main routing and settings expectations`(native: Bool) async throws {
        let fixture = try MacNativeActionFixture()
        do {
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let captured = try #require(await fixture.gateway.captureServerLease())
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                outboxGatewayID: native ? nil : "local-store",
                nativeBinding: native ? .init(owner: fixture.target.owner, lease: captured) : nil)
            let acquired = if native {
                await transport.acquireOutboxRouteLease(ifCurrentServerLease: captured)
            } else {
                await transport.acquireOutboxRouteLease()
            }
            guard case let .available(lease) = acquired else {
                Issue.record("Expected a live routing lease")
                await fixture.gateway.shutdown()
                return
            }
            let response = try await lease.sendMessage(
                sessionKey: "main",
                agentID: "main",
                expectedSessionSettings: .init(permissionMode: .guarded, toolOverrides: nil),
                message: "native",
                thinking: "off",
                idempotencyKey: "operation",
                attachments: [])
            #expect(response.runId == "gateway-accepted-run")
            let frames = try fixture.frames(method: "chat.send")
            try #require(frames.count == 1)
            let frame = frames[0]
            #expect(frame["expectedProfileId"] as? String == (native ? fixture.profileID.value : nil))
            let params = try #require(frame["params"] as? [String: Any])
            #expect(params["sessionKey"] as? String == "agent:main:main")
            #expect(params["expectedSessionRoutingContract"] as? String == "per-sender|main|main")
            #expect(params["expectedPermissionMode"] as? String == "guarded")
            #expect(params["expectedToolOverrides"] is NSNull)
            _ = try await lease.requestHistory(sessionKey: "main", agentID: "main")
            let history = try fixture.frames(method: "chat.history")
            try #require(history.count == 1)
            #expect(history[0]["expectedProfileId"] as? String == (native ? fixture.profileID.value : nil))
            #expect((history[0]["params"] as? [String: Any])?["sessionKey"] as? String == "agent:main:main")
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `outbox leases distinguish ordinary reconnects from native socket retirement`(
        native: Bool) async throws
    {
        let fixture = try MacNativeActionFixture()
        do {
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let original = try #require(await fixture.gateway.captureServerLease())
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                outboxGatewayID: native ? nil : "local-store",
                nativeBinding: native ? .init(owner: fixture.target.owner, lease: original) : nil)
            guard case let .available(lease) = await transport.acquireOutboxRouteLease() else {
                Issue.record("Expected a live outbox lease")
                throw CancellationError()
            }
            let originalSocket = try #require(fixture.sockets.latestTask())
            // Retire only the socket. GatewayConnection.shutdown() would also
            // retire the logical route and test a different ownership boundary.
            originalSocket.emitReceiveFailure()
            let deadline = ContinuousClock.now + .seconds(3)
            while fixture.gateway.serverLeaseMatchesCurrentState(original), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(!fixture.gateway.serverLeaseMatchesCurrentState(original))
            try #require(await fixture.gateway.isCurrentRoute(original.route))
            _ = try await fixture.gateway.request(method: "health", params: nil)
            let replacement = try #require(await fixture.gateway.captureServerLease())
            try #require(replacement != original)
            try #require(replacement.route == original.route)
            try #require(await fixture.gateway.isCurrentServerLease(original) == false)
            try #require(fixture.sockets.snapshotMakeCount() == 2)

            if native {
                guard case .unavailable = await transport.acquireOutboxRouteLease() else {
                    Issue.record("A native binding acquired a lease on its replacement socket")
                    throw CancellationError()
                }
                await #expect(throws: OpenClawChatTransportSendError.self) {
                    _ = try await lease.sendMessage(
                        sessionKey: "main", agentID: "main",
                        message: "not dispatched", thinking: "off",
                        idempotencyKey: "native-operation", attachments: [])
                }
                await #expect(throws: OpenClawChatTransportSendError.self) {
                    _ = try await lease.requestHistory(sessionKey: "main", agentID: "main")
                }
                #expect(try fixture.frames(method: "chat.send").isEmpty)
                #expect(try fixture.frames(method: "chat.history").isEmpty)
                #expect(fixture.sockets.snapshotMakeCount() == 2)
                await fixture.gateway.shutdown()
                return
            }

            let response = try await lease.sendMessage(
                sessionKey: "main",
                agentID: "main",
                expectedSessionSettings: .init(permissionMode: .guarded, toolOverrides: nil),
                message: "queued before reconnect",
                thinking: "off",
                idempotencyKey: "queued-operation",
                attachments: [])
            #expect(response.runId == "gateway-accepted-run")
            #expect(response.status == "started")
            let history = try await lease.requestHistory(sessionKey: "main", agentID: "main")
            #expect(history.sessionInfo?.key == "agent:main:main")
            #expect(history.sessionInfo?.agentId == "main")

            let sends = try fixture.frames(method: "chat.send")
            try #require(sends.count == 1)
            #expect(sends[0]["expectedProfileId"] == nil)
            let params = try #require(sends[0]["params"] as? [String: Any])
            #expect(params["sessionKey"] as? String == "agent:main:main")
            #expect(params["agentId"] as? String == "main")
            #expect(params["message"] as? String == "queued before reconnect")
            #expect(params["thinking"] as? String == "off")
            #expect(params["idempotencyKey"] as? String == "queued-operation")
            #expect(params["expectedSessionRoutingContract"] as? String == "per-sender|main|main")
            #expect(params["expectedPermissionMode"] as? String == "guarded")
            #expect(params["expectedToolOverrides"] is NSNull)
            let histories = try fixture.frames(method: "chat.history")
            try #require(histories.count == 1)
            #expect(histories[0]["expectedProfileId"] == nil)
            let historyParams = try #require(histories[0]["params"] as? [String: Any])
            #expect(historyParams["sessionKey"] as? String == "agent:main:main")
            #expect(historyParams["agentId"] as? String == "main")
            #expect(fixture.sockets.snapshotMakeCount() == 2)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test func `native history and metadata never reacquire or drop the expected profile`() async throws {
        let fixture = try MacNativeActionFixture()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                defaultGlobalAgentID: fixture.target.agentID,
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            _ = try await transport.requestHistory(sessionKey: fixture.target.sessionKey)
            _ = try await transport.listSessions(limit: 50, search: nil, archived: false)
            _ = try await transport.listAgents()
            let options = try #require(await transport.acquireNewSessionRouteLease())
            _ = try await options.listAgents()
            for method in ["chat.history", "sessions.list", "agents.list"] {
                let frames = try fixture.frames(method: method)
                #expect(!frames.isEmpty)
                #expect(frames.allSatisfy { $0["expectedProfileId"] as? String == fixture.profileID.value })
            }
            fixture.profileID.setValue("other-profile")
            await #expect(throws: GatewayResponseError.self) {
                _ = try await transport.requestHistory(sessionKey: fixture.target.sessionKey)
            }
            #expect(await fixture.gateway.isCurrentServerLease(lease))
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.acquireServerLease()
            #expect(await transport.captureChatServerLease() == nil)
            await #expect(throws: OpenClawChatTransportSendError.self) { _ = try await options.listAgents() }
            #expect(try fixture.frames(method: "agents.list").count == 2)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["profile-one", "other-profile", "missing"])
    func `native events require an exact recipient profile on the captured physical lease`(
        recipient: String) async throws
    {
        let fixture = try MacNativeActionFixture()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            var fields: [String: Any] = ["type": "event", "event": "tick", "seq": 1]
            if recipient != "missing" { fields["recipientProfileId"] = recipient }
            let event = try JSONDecoder().decode(
                EventFrame.self, from: JSONSerialization.data(withJSONObject: fields))
            let delivery = try #require(await fixture.gateway.makePushDelivery(.event(event)))
            #expect(transport.acceptsNativeDelivery(delivery) == (recipient == fixture.target.owner.profileID))
            let ordinary = MacGatewayChatTransport(connection: fixture.gateway)
            #expect(ordinary.acceptsNativeDelivery(delivery))
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.acquireServerLease()
            let replacement = try #require(await fixture.gateway.makePushDelivery(.event(event)))
            #expect(!transport.acceptsNativeDelivery(replacement))
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `canonical chat rejects a retired lease before dispatch`(send: Bool) async throws {
        let fixture = try MacNativeActionFixture()
        do {
            let original = try await fixture.gateway.acquireServerLease()
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.acquireServerLease()
            await #expect(throws: OpenClawChatTransportSendError.self) {
                if send {
                    _ = try await fixture.gateway.chatSend(
                        sessionKey: "main",
                        message: "native",
                        thinking: "off",
                        idempotencyKey: "operation",
                        attachments: [],
                        ifCurrentServerLease: original)
                } else {
                    _ = try await fixture.gateway.chatHistory(sessionKey: "main", ifCurrentServerLease: original)
                }
            }
            #expect(try fixture.frames(method: send ? "chat.send" : "chat.history").isEmpty)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `canonical send requires negotiated settings CAS and one route authority`(
        conflictingRoutes: Bool) async throws
    {
        let fixture = try MacNativeActionFixture()
        if !conflictingRoutes {
            fixture.capabilities
                .withValue { $0.removeAll { $0 == GatewayServerCapability.sessionSettingsCAS.rawValue } }
        }
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await fixture.gateway.chatSend(
                    sessionKey: "main",
                    expectedSessionSettings: .init(permissionMode: .guarded, toolOverrides: nil),
                    message: "native",
                    thinking: "off",
                    idempotencyKey: "operation",
                    attachments: [],
                    ifCurrentRoute: conflictingRoutes ? lease.route : nil,
                    ifCurrentServerLease: lease)
            }
            if conflictingRoutes {
                await #expect(throws: OpenClawChatTransportSendError.self) {
                    _ = try await fixture.gateway.chatHistory(
                        sessionKey: "main", ifCurrentRoute: lease.route, ifCurrentServerLease: lease)
                }
            }
            #expect(try fixture.frames(method: "chat.send").isEmpty)
            #expect(try fixture.frames(method: "chat.history").isEmpty)
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["chat.send", "chat.history"])
    func `canonical chat cannot adopt a replacement socket after dispatch`(method: String) async throws {
        let fixture = try MacNativeActionFixture(holding: method)
        var pending: Task<Void, Error>?
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let request = Task {
                if method == "chat.send" {
                    _ = try await fixture.gateway.chatSend(
                        sessionKey: "main",
                        message: "native",
                        thinking: "off",
                        idempotencyKey: "operation",
                        attachments: [],
                        ifCurrentServerLease: lease)
                } else {
                    _ = try await fixture.gateway.chatHistory(sessionKey: "main", ifCurrentServerLease: lease)
                }
            }
            pending = request
            let deadline = ContinuousClock.now + .seconds(3)
            while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(fixture.heldRequest.value != nil)
            await fixture.gateway.shutdown()
            _ = try await fixture.gateway.acquireServerLease()
            fixture.releaseRequest()
            await #expect(throws: CancellationError.self) { try await request.value }
            #expect(try fixture.frames(method: method).count == 1)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            _ = try? await pending?.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["direct", "targeted", "captured"])
    func `native send receipts survive lease retirement without granting fresh authority`(
        _ path: String) async throws
    {
        let fixture = try MacNativeActionFixture(holding: "chat.send")
        var pending: Task<OpenClawChatSendResponse, Error>?
        do {
            let original = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                nativeBinding: .init(owner: fixture.target.owner, lease: original))
            let acquired = await transport.acquireOutboxRouteLease(ifCurrentServerLease: original)
            guard case let .available(captured) = acquired else {
                Issue.record("Expected a live native send lease")
                throw CancellationError()
            }
            let request = Task {
                switch path {
                case "captured":
                    try await captured.sendMessage(
                        sessionKey: fixture.target.sessionKey, agentID: "main",
                        message: "native", thinking: "off", idempotencyKey: "operation", attachments: [])
                case "targeted":
                    try await transport.sendMessage(
                        sessionKey: fixture.target.sessionKey, agentID: "main",
                        expectedSessionRoutingContract: captured.sessionRoutingContract,
                        message: "native", thinking: "off", idempotencyKey: "operation", attachments: [])
                default:
                    try await transport.sendMessage(
                        sessionKey: fixture.target.sessionKey,
                        message: "native", thinking: "off", idempotencyKey: "operation", attachments: [])
                }
            }
            pending = request
            let deadline = ContinuousClock.now + .seconds(3)
            while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(fixture.heldRequest.value != nil)
            // Keep the original socket alive to deliver its ACK after the
            // endpoint owner retires. No replacement request may supply the receipt.
            fixture.routeAuthority.setValue(1)
            fixture.releaseRequest()
            let response = try await request.value
            #expect(response.runId == "gateway-accepted-run")
            #expect(await fixture.gateway.isCurrentServerLease(original) == false)
            #expect(await transport.captureChatServerLease() == nil)
            await #expect(throws: OpenClawChatTransportSendError.self) {
                _ = try await captured.sendMessage(
                    sessionKey: fixture.target.sessionKey, agentID: "main",
                    message: "later", thinking: "off", idempotencyKey: "later", attachments: [])
            }
            let frames = try fixture.frames(method: "chat.send")
            #expect(frames.count == 1)
            #expect(frames.first?["expectedProfileId"] as? String == fixture.target.owner.profileID)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            _ = try? await pending?.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["default", "ordinary", "wrong-method", "rpc-error", "malformed"])
    func `retired lease results remain strict outside native send receipts`(_ scenario: String) async throws {
        let method = scenario == "wrong-method" ? "chat.history" : "chat.send"
        let fixture = try MacNativeActionFixture(holding: method)
        var pending: Task<Void, Error>?
        do {
            let original = try await fixture.gateway.acquireServerLease()
            let transport = MacGatewayChatTransport(
                connection: fixture.gateway,
                outboxGatewayID: scenario == "ordinary" ? "local-store" : nil,
                nativeBinding: scenario == "ordinary" ? nil : .init(owner: fixture.target.owner, lease: original))
            let acquired = if scenario == "ordinary" {
                await transport.acquireOutboxRouteLease()
            } else {
                await transport.acquireOutboxRouteLease(ifCurrentServerLease: original)
            }
            guard case let .available(captured) = acquired else {
                Issue.record("Expected a live send lease")
                throw CancellationError()
            }
            let request = Task {
                switch scenario {
                case "default":
                    _ = try await fixture.gateway.chatSend(
                        sessionKey: fixture.target.sessionKey,
                        message: "native", thinking: "off", idempotencyKey: "operation", attachments: [],
                        ifCurrentServerLease: original)
                case "wrong-method":
                    _ = try await fixture.gateway.request(
                        method: method,
                        params: ["sessionKey": .init(fixture.target.sessionKey)],
                        ifCurrentServerLease: original,
                        completionPolicy: .preserveChatSendSuccess)
                default:
                    _ = try await captured.sendMessage(
                        sessionKey: fixture.target.sessionKey, agentID: "main",
                        message: "native", thinking: "off", idempotencyKey: "operation", attachments: [])
                }
            }
            pending = request
            let deadline = ContinuousClock.now + .seconds(3)
            while fixture.heldRequest.value == nil, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(fixture.heldRequest.value != nil)
            fixture.routeAuthority.setValue(1)
            if scenario == "rpc-error" {
                try fixture.rejectRequest(code: "UNAVAILABLE")
            } else {
                if scenario == "malformed" {
                    let (socket, response) = try #require(fixture.heldRequest.value)
                    var frame = try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])
                    frame["payload"] = ["status": "started"]
                    let encoded = try JSONSerialization.data(withJSONObject: frame)
                    fixture.heldRequest.setValue((socket, encoded))
                }
                fixture.releaseRequest()
            }
            await #expect(throws: CancellationError.self) { try await request.value }
            #expect(try fixture.frames(method: method).count == 1)
        } catch {
            fixture.releaseRequest()
            await fixture.gateway.shutdown()
            _ = try? await pending?.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

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
        _ run: (MacGatewayChatTransport, RequestRecorder) async throws -> Void) async throws
    {
        let recorder = RequestRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                let method = try #require(GatewayWebSocketTestSupport.requestMethod(from: message))
                if method != "health" {
                    let data: Data = switch message {
                    case let .data(value): value
                    case let .string(value): Data(value.utf8)
                    @unknown default: throw URLError(.cannotParseResponse)
                    }
                    await recorder.append(data)
                }
                let payload = switch method {
                case "agents.list": GatewayWebSocketTestSupport.agentCatalogPayload
                case "sessions.rewind": #"{"editorText":"rewound draft"}"#
                case "sessions.fork": #"{"sessionKey":"forked","editorText":"continued draft"}"#
                default: #"{"ok":true}"#
                }
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(id)","ok":true,"payload":\#(payload)}"#.utf8)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    methods: ["agents.list", "sessions.patch", "sessions.delete", "sessions.rewind", "sessions.fork"],
                    capabilities: ["session-unread-ack-contract"]))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        do {
            _ = try await gateway.request(method: "health", params: nil)
            let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: "agent-a")
            try await run(transport, recorder)
            await gateway.shutdown()
        } catch {
            await gateway.shutdown()
            throw error
        }
    }

    @Test func `new session rosters preserve selectable choices on their captured connection`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let expected = OpenClawChatAgentsListResponse(
                defaultId: "system",
                agents: [
                    OpenClawChatAgentChoice(id: "zeta", name: " Zeta ", workspaceGit: true),
                    OpenClawChatAgentChoice(id: "legacy"),
                    OpenClawChatAgentChoice(id: "alpha", workspaceGit: false),
                ])
            #expect(try await transport.listAgents() == expected)
            let lease = try #require(await transport.acquireNewSessionRouteLease())
            #expect(try await lease.listAgents() == expected)
            await transport.connection.shutdown()
            await #expect(throws: Error.self) {
                _ = try await lease.listAgents()
            }
            let frames = try await recorder.snapshot().map {
                try #require(JSONSerialization.jsonObject(with: $0) as? [String: Any])
            }
            #expect(frames.map { $0["method"] as? String } == ["agents.list", "agents.list"])
            #expect(frames.allSatisfy { ($0["params"] as? [String: Any])?.isEmpty == true })
        }
    }

    @Test func `mutation lease resolves the current global agent for each request`() async throws {
        try await self.withSessionTransport { transport, recorder in
            let lease = try #require(await transport.acquireSessionMutationRouteLease())
            try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                pinned: true,
                archived: nil,
                unread: nil)
            let observerTransport = transport
            observerTransport.updateDefaultGlobalAgentID(" Agent-B ")
            try await lease.patchSession(
                key: "global",
                label: nil,
                category: nil,
                color: .some(nil),
                pinned: nil,
                archived: nil,
                unread: nil)
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

        let unowned = MacGatewayChatTransport()
            .sessionsListRequest(limit: nil, search: nil, archived: false)
        #expect(unowned.params["agentId"] == nil)
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
                model: .some("openai/gpt-5.6-sol"),
                thinkingLevel: .some(nil),
                fastMode: .some(.on),
                verboseLevel: .some("full")))

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["model"]?.value as? String == "openai/gpt-5.6-sol")
        #expect(request.params["thinkingLevel"]?.value is NSNull)
        #expect(request.params["fastMode"]?.value as? Bool == true)
        #expect(request.params["verboseLevel"]?.value as? String == "full")
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
