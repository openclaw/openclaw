import Foundation
import OpenClawChatUI
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatModelTests {
    @Test(arguments: ["started", "ok", "in_flight"])
    func `accepted send clears text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = " hello "

        #expect(await model.send())
        #expect(model.sendState == .sent)
        #expect(model.text.isEmpty)
    }

    @Test func `new draft clears sent presentation state`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "first"
        #expect(await model.send())
        #expect(model.sendState == .sent)

        model.text = "second"

        #expect(model.sendState == .idle)
    }

    @Test(arguments: ["error", "timeout"])
    func `terminal failure preserves text`(_ status: String) async {
        let model = self.makeModel(sendStatus: status)
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        guard case let .failed(message) = model.sendState else {
            Issue.record("expected failed send state")
            return
        }
        #expect(message.contains(status))
        #expect(model.text == "hello")
    }

    @Test func `thrown send error becomes failure`() async {
        let model = self.makeModel(sendError: FakeSendError.rejected)
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        #expect(model.sendState == QuickChatSendState.failed("Fake rejection"))
        #expect(model.text == "hello")
    }

    @Test func `unchanged draft reuses idempotency key after transport failure`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, _, _, idempotencyKey, _ in
            keys.append(idempotencyKey)
            if keys.count == 1 { throw FakeSendError.rejected }
            return "started"
        })
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        #expect(await model.send())
        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `no-op reasoning selection preserves idempotent retry`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, _, _, idempotencyKey, _ in
            keys.append(idempotencyKey)
            if keys.count == 1 { throw FakeSendError.rejected }
            return "started"
        })
        await self.prepare(model)
        model.text = "hello"

        #expect(await !(model.send()))
        model.selectThinkingLevel(nil)
        #expect(await model.send())

        #expect(keys.count == 2)
        #expect(keys[0] == keys[1])
    }

    @Test func `new dispatch clears the previous accepted reply key`() async {
        var shouldFail = false
        let model = self.makeModel(sendHandler: { _, _, _, _, _, _ in
            if shouldFail { throw FakeSendError.rejected }
            return "started"
        })
        await self.prepare(model)
        model.text = "first"
        #expect(await model.send())
        #expect(model.lastAcceptedIdempotencyKey != nil)

        shouldFail = true
        model.text = "second"
        #expect(await !(model.send()))
        #expect(model.lastAcceptedIdempotencyKey == nil)
    }

    @Test func `edited draft gets new idempotency key`() async {
        var keys: [String] = []
        let model = self.makeModel(sendHandler: { _, _, _, _, idempotencyKey, _ in
            keys.append(idempotencyKey)
            throw FakeSendError.rejected
        })
        await self.prepare(model)
        model.text = "first"
        #expect(await !(model.send()))

        model.text = "second"
        #expect(await !(model.send()))

        #expect(keys.count == 2)
        #expect(keys[0] != keys[1])
    }

    @Test func `empty text does not call gateway`() async {
        var sendCount = 0
        let model = self.makeModel(sendHandler: { _, _, _, _, _, _ in
            sendCount += 1
            return "ok"
        })
        await self.prepare(model)
        model.text = "  \n "

        #expect(await !(model.send()))
        #expect(sendCount == 0)
        #expect(model.sendState == .idle)
    }

    @Test func `disconnected gateway disables send`() async {
        var sendCount = 0
        let model = self.makeModel(
            gate: .disconnected,
            sendHandler: { _, _, _, _, _, _ in
                sendCount += 1
                return "ok"
            })
        await self.prepare(model)
        model.text = "hello"

        #expect(!model.canSend)
        #expect(model.connectionStatusMessage == "Gateway disconnected")
        #expect(await !(model.send()))
        #expect(sendCount == 0)
    }

    @Test func `new presentation disables send until session key refreshes`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "hello"
        #expect(model.canSend)

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.sessionKey.isEmpty)
        #expect(!model.canSend)
    }

    @Test func `dismissal lets dispatched send settle without retry`() async {
        let latch = SendLatch()
        let model = self.makeModel(sendHandler: { _, _, _, _, _, _ in
            try await latch.wait()
        })
        await self.prepare(model)
        model.text = "hello"

        let send = Task { await model.send() }
        while !latch.started {
            await Task.yield()
        }
        model.endPresentation()
        latch.finish(with: "started")

        #expect(await send.value)
        #expect(latch.callCount == 1)
        #expect(model.text.isEmpty)
        #expect(model.sendState == .sent)
    }

    @Test func `cached agent display survives representation for the same session`() async {
        let model = self.makeModel()
        await self.prepare(model)
        #expect(model.agentDisplay.name == "Molty")

        model.endPresentation()
        _ = model.beginPresentation()

        #expect(model.agentDisplay.name == "Molty")
    }

    @Test func `selected agent resets to refreshed default when missing`() async {
        let results = AgentsResultsBox(results: [
            Self.agentsResult(defaultID: "one", agentIDs: ["one", "two"]),
            Self.agentsResult(defaultID: "three", agentIDs: ["three", "four"]),
        ])
        let model = self.makeModel(agentsProvider: { results.next() })
        await self.prepare(model)
        model.selectAgent("two")
        #expect(model.selectedAgentID == "two")

        model.endPresentation()
        await self.prepare(model)

        #expect(model.selectedAgentID == "three")
        #expect(model.sessionKey == "agent:three:main")
    }

    @Test func `system agents are not quick chat targets`() async {
        let model = self.makeModel(agentsProvider: {
            Self.agentsResult(
                defaultID: "main",
                agentIDs: ["main", "ordinary-looking-id", "legacy"],
                kinds: [.agent, .system, nil])
        })

        await self.prepare(model)

        #expect(model.agents.map(\.id) == ["main", "legacy"])
    }

    @Test func `grant refreshes permission status immediately`() async {
        let granted = GrantFlag()
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: { Self.agentsResult(defaultID: "main", agentIDs: ["main"]) },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map {
                    ($0, granted.value || $0 != .screenRecording)
                })
            },
            permissionGrantProvider: { capabilities in
                granted.value = true
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            settingsPatchProvider: { _, _ in nil })
        await self.prepare(model)
        #expect(model.missingPermissions == [.screenRecording])

        model.grantMissingPermissions()
        while model.isGrantingPermissions {
            await Task.yield()
        }

        #expect(model.missingPermissions.isEmpty)
        #expect(!model.shouldShowPermissionStrip)
    }

    @Test func `capture controls stay disabled while granting permissions`() async {
        let latch = PermissionGrantLatch()
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: { Self.agentsResult(defaultID: "main", agentIDs: ["main"]) },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, $0 != .accessibility) })
            },
            permissionGrantProvider: { capabilities in
                await latch.wait()
                return Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            settingsPatchProvider: { _, _ in nil })
        await self.prepare(model)

        model.grantMissingPermissions()

        #expect(model.isGrantingPermissions)
        #expect(!model.canCaptureWindow)
        latch.finish()
        while model.isGrantingPermissions {
            await Task.yield()
        }
    }

    @Test func `routing target follows scope contract`() {
        #expect(QuickChatModel.routingTarget(
            scope: "global",
            selectedAgentID: "research",
            mainKey: "main") == OpenClawChatSessionTarget(sessionKey: "global", agentID: "research"))
        #expect(QuickChatModel.routingTarget(
            scope: "per-agent",
            selectedAgentID: "research",
            mainKey: "daily") == OpenClawChatSessionTarget(
            sessionKey: "agent:research:daily",
            agentID: nil))
        #expect(QuickChatModel.routingTarget(
            override: QuickChatSessionTargetOverride(key: "agent:main:telegram:direct:42", displayName: "Chat"),
            base: OpenClawChatSessionTarget(sessionKey: "agent:research:daily", agentID: nil)) ==
            OpenClawChatSessionTarget(sessionKey: "agent:main:telegram:direct:42", agentID: nil))
        #expect(QuickChatModel.routingTarget(
            override: QuickChatSessionTargetOverride(key: "global", displayName: "Global"),
            base: OpenClawChatSessionTarget(sessionKey: "global", agentID: "research")) ==
            OpenClawChatSessionTarget(sessionKey: "global", agentID: "research"))
    }

    @Test func `recent override wins over agent pin and clears back to the pin`() async {
        let model = self.makeModel(agentsProvider: {
            Self.agentsResult(defaultID: "main", agentIDs: ["main", "work"])
        })
        await self.prepare(model)
        #expect(model.sessionKey == "agent:main:main")

        model.selectAgent("work")
        #expect(model.sessionKey == "agent:work:main")

        let recent = QuickChatSessionTargetOverride(
            key: "agent:main:telegram:direct:42",
            displayName: "Release chat")
        model.selectSessionOverride(recent)
        #expect(model.targetSessionOverride == recent)
        #expect(model.sessionKey == recent.key)
        #expect(model.sendAgentID == nil)
        #expect(model.messagePlaceholder == "Reply in Release chat")

        model.selectSessionOverride(nil)
        #expect(model.sessionKey == "agent:work:main")
        #expect(model.messagePlaceholder == "Message work")
    }

    @Test func `recent override resets on hide`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.selectSessionOverride(QuickChatSessionTargetOverride(key: "agent:main:other", displayName: "Other"))

        model.endPresentation()

        #expect(model.targetSessionOverride == nil)
        #expect(model.sessionKey.isEmpty)
    }

    @Test func `agent switch clears recent override`() async {
        let model = self.makeModel(agentsProvider: {
            Self.agentsResult(defaultID: "main", agentIDs: ["main", "work"])
        })
        await self.prepare(model)
        model.selectSessionOverride(QuickChatSessionTargetOverride(key: "agent:main:other", displayName: "Other"))

        model.selectAgent("work")

        #expect(model.targetSessionOverride == nil)
        #expect(model.sessionKey == "agent:work:main")
    }

    @Test func `override send uses canonical session key verbatim`() async {
        var sentRoute: OpenClawChatSessionTarget?
        let model = self.makeModel(sendHandler: { sessionKey, agentID, _, _, _, _ in
            sentRoute = OpenClawChatSessionTarget(sessionKey: sessionKey, agentID: agentID)
            return "started"
        })
        await self.prepare(model)
        let key = "agent:ops:discord:channel:release"
        model.selectSessionOverride(QuickChatSessionTargetOverride(key: key, displayName: "Release"))
        model.text = "hello"

        #expect(await model.send())
        #expect(sentRoute == OpenClawChatSessionTarget(sessionKey: key, agentID: nil))
    }

    @Test func `global override preserves selected global agent`() async {
        var sentRoute: OpenClawChatSessionTarget?
        let model = self.makeModel(
            agentsProvider: {
                Self.agentsResult(
                    defaultID: "main",
                    agentIDs: ["main", "work"],
                    scope: "global")
            },
            sendHandler: { sessionKey, agentID, _, _, _, _ in
                sentRoute = OpenClawChatSessionTarget(sessionKey: sessionKey, agentID: agentID)
                return "started"
            })
        await self.prepare(model)
        model.selectAgent("work")
        model.selectSessionOverride(QuickChatSessionTargetOverride(key: "global", displayName: "Global"))
        model.text = "hello"

        #expect(await model.send())
        #expect(sentRoute == OpenClawChatSessionTarget(sessionKey: "global", agentID: "work"))
    }

    @Test func `agent display parses avatar forms and monogram`() {
        let imageData = Data([0x89, 0x50, 0x4E, 0x47])
        let dataSummary = AgentSummary(
            id: "molty",
            name: "Molty",
            identity: [
                "emoji": AnyCodable("🦞"),
                "avatarUrl": AnyCodable("data:image/png;base64,\(imageData.base64EncodedString())"),
            ])
        let dataDisplay = QuickChatAgentDisplay(summary: dataSummary)
        #expect(dataDisplay.emoji == "🦞")
        #expect(dataDisplay.avatar == .image(imageData))
        #expect(dataDisplay.monogram == "M")

        // Remote URLs are never fetched (SSRF surface); they fall back to emoji/monogram.
        let remoteDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "remote",
            identity: ["avatarUrl": AnyCodable("https://example.com/avatar.png")]))
        #expect(remoteDisplay.name == "remote")
        #expect(remoteDisplay.avatar == .none)
        #expect(remoteDisplay.monogram == "R")

        let relativeDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "relative",
            identity: ["avatarUrl": AnyCodable("/avatar/relative")]))
        #expect(relativeDisplay.avatar == .none)

        let oversized = String(repeating: "A", count: 8_000_004)
        let oversizedDisplay = QuickChatAgentDisplay(summary: AgentSummary(
            id: "large",
            identity: ["avatarUrl": AnyCodable("data:image/png;base64,\(oversized)")]))
        #expect(oversizedDisplay.avatar == .none)
    }

    @Test func `agent selection before refresh keeps routing empty`() async {
        let model = self.makeModel(agentsProvider: {
            Self.agentsResult(defaultID: "one", agentIDs: ["one", "two"])
        })
        await self.prepare(model)
        #expect(!model.sessionKey.isEmpty)

        model.endPresentation()
        _ = model.beginPresentation()
        model.selectAgent("two")

        #expect(model.sessionKey.isEmpty)
        model.text = "hello"
        #expect(!model.canSend)
    }

    @Test func `accepted send records its immutable route`() async {
        let model = self.makeModel()
        await self.prepare(model)
        model.text = "hello"

        #expect(await model.send())
        #expect(model.lastAcceptedRoute == OpenClawChatSessionTarget(
            sessionKey: "agent:main:main",
            agentID: nil))
    }

    @Test(.testWaitLimit, arguments: ["accepted", "startup", "replaced-gateway"])
    func `pending screenshot keeps its payload and draft without crossing gateway replacement`(
        scenario: String) async throws
    {
        let latch = SendLatch()
        let source = try GatewayConnectionEndpointSource(url: #require(URL(string: "ws://quickchat-test.invalid")))
        var sends: [Data] = []
        let recordSend: @MainActor @Sendable (Data) -> Int = { params in
            sends.append(params)
            return sends.count
        }
        let sockets = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: Data()
                }
                let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                try #require(frame["method"] as? String == "chat.send")
                let params = try #require(frame["params"] as? [String: Any])
                let attempt = try await recordSend(JSONSerialization.data(withJSONObject: params, options: .sortedKeys))
                var response: [String: Any] = try [
                    "type": "res", "id": #require(frame["id"] as? String), "ok": true,
                    "payload": ["runId": #require(params["idempotencyKey"] as? String), "status": "started"],
                ]
                if attempt == 1 {
                    _ = try await latch.wait()
                    if scenario != "accepted" {
                        response["ok"] = false
                        response["error"] = [
                            "code": "UNAVAILABLE", "message": "Agent is preparing", "retryable": true,
                            "retryAfterMs": 1,
                            "details": ["reason": "startup-sidecars", "method": "chat.send"],
                        ]
                    }
                }
                try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: response)))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { source.snapshot().config },
            sessionBox: WebSocketSessionBox(session: sockets))
        let model = self.makeModel(sendHandler: QuickChatModel.gatewaySendProvider(gateway: gateway))
        await self.prepare(model)
        let png = try #require(Data(
            base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAA" +
                "C0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let pipelineID = try #require(model.beginCapturePipeline())
        let send = Task { await model.sendCapturedImage(
            pipelineID: pipelineID, data: png, label: "Synthetic window", fileName: "window.jpg") }
        defer {
            model.cancelAllTasks()
            latch.finish(with: "started")
        }
        while !latch.started {
            try Task.checkCancellation()
            await Task.yield()
        }
        model.text = "typed while sending"
        #expect(model.sendState == .sending)
        if scenario == "replaced-gateway" {
            try source.setURL(#require(URL(string: "ws://replacement-test.invalid")))
        }
        latch.finish(with: "started")
        let accepted = await send.value
        await gateway.shutdown()

        #expect(accepted == (scenario != "replaced-gateway"))
        try #require(sends.count == (scenario == "startup" ? 2 : 1))
        let first = try #require(JSONSerialization.jsonObject(with: sends[0]) as? [String: Any])
        #expect(first["message"] as? String == "Screenshot: Synthetic window")
        #expect(first["sessionKey"] as? String == "agent:main:main")
        #expect((first["attachments"] as? [[String: Any]])?.count == 1)
        if accepted { #expect(model.lastAcceptedIdempotencyKey == first["idempotencyKey"] as? String) }
        if scenario == "startup" { #expect(sends[0] == sends[1]) }
        #expect(sockets.snapshotMakeCount() == 1)
        #expect(model.text == "typed while sending")
        #expect(model.sendState == .idle)
    }

    @Test func `capture pipeline blocks concurrent sends and unwinds`() async {
        var sendCount = 0
        let model = self.makeModel(sendHandler: { _, _, _, _, _, _ in
            sendCount += 1
            return "ok"
        })
        await self.prepare(model)

        let pipelineID = model.beginCapturePipeline()
        #expect(pipelineID != nil)
        #expect(model.sendState == .sending)
        #expect(model.beginCapturePipeline() == nil)
        model.text = "typed during capture"
        #expect(!model.canSend)
        #expect(!model.canCaptureWindow)
        #expect(await !(model.send()))
        #expect(sendCount == 0)

        model.cancelCapturePipeline(pipelineID ?? UUID())
        #expect(model.sendState == .idle)
        #expect(model.canSend)
    }

    @Test func `stale pipeline token cannot reset a newer pipeline`() throws {
        let model = self.makeModel()
        let staleID = try #require(model.beginCapturePipeline())
        model.cancelCapturePipeline(staleID)
        #expect(model.sendState == .idle)

        let currentID = try #require(model.beginCapturePipeline())
        model.cancelCapturePipeline(staleID)
        model.failCapturePipeline(staleID)
        #expect(model.sendState == .sending)

        model.cancelCapturePipeline(currentID)
        #expect(model.sendState == .idle)
    }

    @Test(arguments: [("", "retry"), ("Explain this", "retry"), ("Explain this", "edit"), ("Explain this", "target")])
    func `rejected screenshot keeps its payload for an unchanged retry`(
        _ draft: String,
        _ action: String) async throws
    {
        var sentMessages: [String] = []
        var sentAttachments: [[OpenClawChatAttachmentPayload]] = []
        var sentKeys: [String] = []
        var sentSessions: [String] = []
        let model = self.makeModel(sendHandler: { session, _, message, _, key, attachments in
            sentSessions.append(session)
            sentMessages.append(message)
            sentAttachments.append(attachments)
            sentKeys.append(key)
            if sentKeys.count == 1 {
                throw GatewayResponseError(
                    method: "chat.send",
                    code: "UNAVAILABLE",
                    message: "Synthetic startup refusal",
                    details: [
                        "reason": AnyCodable("startup-sidecars"),
                        "retryable": AnyCodable(true),
                        "method": AnyCodable("chat.send"),
                    ])
            }
            return "started"
        })
        await self.prepare(model)
        model.text = draft
        let png = try #require(Data(
            base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAA" +
                "C0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
        let pipelineID = try #require(model.beginCapturePipeline())
        #expect(await !(model.sendCapturedImage(
            pipelineID: pipelineID, data: png, label: "Synthetic window", fileName: "window.jpg")))
        guard case .failed = model.sendState else {
            Issue.record("expected visible screenshot send failure")
            return
        }
        #expect(sentMessages[0] == (draft.isEmpty ? "Screenshot: Synthetic window" : draft))
        let attachment = try #require(sentAttachments[0].first)
        #expect(attachment.type == "file" && attachment.mimeType == "image/jpeg")
        #expect(attachment.fileName == "window.jpg" && !attachment.content.hasPrefix("data:"))
        if action == "edit" { model.text = "Replacement" }
        if action == "target" {
            model.selectSessionOverride(.init(key: "agent:main:other", displayName: "Other"))
        }
        #expect(model.canSend)
        #expect(await model.send())
        try #require(sentKeys.count == 2)
        #expect((sentKeys[0] == sentKeys[1]) == (action == "retry"))
        #expect(sentMessages[1] == (action == "edit" ? "Replacement" : sentMessages[0]))
        #expect(sentAttachments[1] == (action == "retry" ? [attachment] : []))
        #expect(sentSessions[1] == (action == "target" ? "agent:main:other" : "agent:main:main"))
    }

    @Test func `message assembly appends context block`() {
        let context = QuickChatTextContext(
            appName: "Safari",
            windowTitle: "Docs",
            text: "Selected text")

        #expect(QuickChatModel.assembleMessage(draft: "Question", context: context) == """
        Question

        [Context from Safari — Docs]
        Selected text
        """)
        #expect(QuickChatModel.assembleMessage(draft: "  ", context: context) == """
        [Context from Safari — Docs]
        Selected text
        """)
    }

    @Test func `accepted send clears attached context`() async {
        var receivedMessage: String?
        let model = self.makeModel(sendHandler: { _, _, message, _, _, _ in
            receivedMessage = message
            return "ok"
        })
        await self.prepare(model)
        model.replaceTextContext(QuickChatTextContext(
            appName: "Notes",
            windowTitle: "Plan",
            text: "Ship it"))

        #expect(model.canSend)
        #expect(await model.send())
        #expect(receivedMessage == """
        [Context from Notes — Plan]
        Ship it
        """)
        #expect(model.textContext == nil)
    }

    @Test func `context replaces and clears on hide`() async {
        let model = self.makeModel()
        await self.prepare(model)
        let first = QuickChatTextContext(appName: "One", windowTitle: "First", text: "old")
        let second = QuickChatTextContext(appName: "Two", windowTitle: "Second", text: "new")

        model.replaceTextContext(first)
        model.replaceTextContext(second)
        #expect(model.textContext == second)

        model.endPresentation()
        #expect(model.textContext == nil)
    }

    @Test func `permission strip tracks missing permissions and session dismissal`() async {
        let model = self.makeModel(permissionStatus: [
            .notifications: false,
            .accessibility: true,
            .screenRecording: false,
        ])
        await self.prepare(model)

        #expect(model.missingPermissions == [.notifications, .screenRecording])
        #expect(model.shouldShowPermissionStrip)
        model.dismissPermissionsForSession()
        #expect(!model.shouldShowPermissionStrip)
    }

    private func prepare(_ model: QuickChatModel) async {
        let id = model.beginPresentation()
        await model.refreshForPresentation(id: id)
    }

    private func makeModel(
        gate: QuickChatConnectionGate = .available,
        sendStatus: String = "ok",
        sendError: Error? = nil,
        permissionStatus: [Capability: Bool]? = nil,
        agentsProvider: QuickChatModel.AgentsProvider? = nil,
        sendHandler: QuickChatModel.SendProvider? = nil) -> QuickChatModel
    {
        QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: agentsProvider ?? {
                Self.agentsResult(defaultID: "main", agentIDs: ["main"], names: ["Molty"])
            },
            agentIdentityProvider: { _ in
                QuickChatAgentDisplay(id: "main", name: "Molty", emoji: "🦞")
            },
            sendProvider: sendHandler ?? { _, _, _, _, _, _ in
                if let sendError { throw sendError }
                return sendStatus
            },
            permissionStatusProvider: { capabilities in
                permissionStatus ?? Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { gate },
            modelControlsProvider: { _ in .testFixture },
            settingsPatchProvider: { _, _ in nil })
    }

    private static func agentsResult(
        defaultID: String,
        agentIDs: [String],
        names: [String] = [],
        kinds: [AgentKind?] = [],
        scope: String = "per-agent") -> AgentsListResult
    {
        AgentsListResult(
            defaultid: defaultID,
            mainkey: "main",
            scope: AnyCodable(scope),
            agents: agentIDs.enumerated().map { index, id in
                AgentSummary(
                    id: id,
                    kind: kinds.indices.contains(index) ? kinds[index] : nil,
                    name: names.indices.contains(index) ? names[index] : id,
                    identity: ["emoji": AnyCodable("🦞")])
            })
    }
}

private enum FakeSendError: LocalizedError {
    case rejected

    var errorDescription: String? {
        "Fake rejection"
    }
}

@MainActor
private final class GrantFlag {
    var value = false
}

@MainActor
private final class PermissionGrantLatch {
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false

    func wait() async {
        if self.finished { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish() {
        self.finished = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

@MainActor
private final class AgentsResultsBox {
    private var results: [AgentsListResult]

    init(results: [AgentsListResult]) {
        self.results = results
    }

    func next() -> AgentsListResult {
        self.results.removeFirst()
    }
}

@MainActor
private final class SendLatch {
    private var continuation: CheckedContinuation<String, any Error>?
    private(set) var callCount = 0

    var started: Bool {
        self.continuation != nil
    }

    func wait() async throws -> String {
        self.callCount += 1
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
        }
    }

    func finish(with status: String) {
        self.continuation?.resume(returning: status)
        self.continuation = nil
    }
}
