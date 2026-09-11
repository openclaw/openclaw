import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor NativeSubmissionGate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private(set) var entered = false

    func wait() async {
        self.entered = true
        guard !self.opened else { return }
        await withCheckedContinuation { self.waiters.append($0) }
    }

    func open() {
        self.opened = true
        let waiters = self.waiters
        self.waiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private final class NativeSubmissionLifetime: Sendable {}

private actor NativeSubmissionTransport: OpenClawChatTransport {
    enum Response: Sendable {
        case accepted
        case rejected
        case uncertain
    }

    struct Sent: Sendable {
        let key: String
        let agent: String?
        let settings: OpenClawChatSessionSettingsExpectation?
        let text: String
        let id: String
        let attachments: [OpenClawChatAttachmentPayload]
    }

    static let contract = "per-sender|main|agent-a"
    nonisolated let supportsComposerCapabilities: Bool
    let supportsSessionSettingsCAS: Bool
    let sendGate: NativeSubmissionGate?
    let historyGate: NativeSubmissionGate?
    let validationGate: NativeSubmissionGate?
    let response: Response
    let ackStatus: String
    let ackRunID: String?
    let ackSummary: String?
    let onAcceptedRun: (@MainActor @Sendable (String?) -> Void)?
    let validationGateCall: Int
    private var responseError: GatewayResponseError?
    private var generation = 0
    private(set) var validationCalls = 0
    private(set) var catalogLoads = 0
    private(set) var sent: [Sent] = []
    private(set) var historyCalls = 0
    private(set) var historyReturns = 0
    private var historyPayload: OpenClawChatHistoryPayload?

    init(
        response: Response = .accepted,
        ackStatus: String = "started",
        ackRunID: String? = nil,
        ackSummary: String? = nil,
        onAcceptedRun: (@MainActor @Sendable (String?) -> Void)? = nil,
        sendGate: NativeSubmissionGate? = nil,
        historyGate: NativeSubmissionGate? = nil,
        validationGate: NativeSubmissionGate? = nil,
        validationGateCall: Int = 1,
        supportsComposerCapabilities: Bool = false,
        supportsSessionSettingsCAS: Bool = true,
        responseError: GatewayResponseError? = nil)
    {
        self.response = response
        self.ackStatus = ackStatus
        self.ackRunID = ackRunID
        self.ackSummary = ackSummary
        self.onAcceptedRun = onAcceptedRun
        self.sendGate = sendGate
        self.historyGate = historyGate
        self.validationGate = validationGate
        self.validationGateCall = validationGateCall
        self.supportsComposerCapabilities = supportsComposerCapabilities
        self.supportsSessionSettingsCAS = supportsSessionSettingsCAS
        self.responseError = responseError
    }

    func invalidate() {
        self.generation += 1
    }

    func setResponseError(_ error: GatewayResponseError) {
        self.responseError = error
    }

    func setHistoryPayload(_ payload: OpenClawChatHistoryPayload) {
        self.historyPayload = payload
    }

    func route(
        _ target: OpenClawNativeSessionRef,
        sendLifetime: NativeSubmissionLifetime? = nil) -> OpenClawChatExternalSubmissionRoute
    {
        let generation = self.generation
        return OpenClawChatExternalSubmissionRoute(
            target: target,
            lease: OpenClawChatTransportRouteLease(
                sendTargetedMessageWithSettings: { key, agent, settings, text, _, id, attachments in
                    defer { withExtendedLifetime(sendLifetime) {} }
                    guard await self.generation == generation else {
                        throw OpenClawChatTransportSendError.notDispatched
                    }
                    return try await self.deliver(
                        Sent(key: key, agent: agent, settings: settings, text: text, id: id, attachments: attachments),
                        generation: generation)
                },
                requestTargetedHistory: { key, _ in try await self.requestHistory(sessionKey: key) },
                sessionRoutingContract: Self.contract,
                supportsSessionSettingsCAS: self.supportsSessionSettingsCAS),
            isCurrent: { await self.validate(generation: generation) })
    }

    private func validate(generation: Int) async -> Bool {
        self.validationCalls += 1
        if self.validationCalls >= self.validationGateCall {
            await self.validationGate?.wait()
        }
        return self.generation == generation
    }

    private func deliver(_ message: Sent, generation: Int) async throws -> OpenClawChatSendResponse {
        self.sent.append(message)
        await self.sendGate?.wait()
        guard self.generation == generation else { throw CancellationError() }
        if let responseError { throw responseError }
        switch self.response {
        case .accepted:
            return OpenClawChatSendResponse(
                runId: self.ackRunID ?? "remote-\(message.id)",
                status: self.ackStatus,
                summary: self.ackSummary,
                onAcceptedRun: self.onAcceptedRun)
        case .rejected:
            return OpenClawChatSendResponse(runId: message.id, status: "error", onAcceptedRun: self.onAcceptedRun)
        case .uncertain:
            throw URLError(.networkConnectionLost)
        }
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking _: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.deliver(
            Sent(
                key: sessionKey,
                agent: nil,
                settings: nil,
                text: message,
                id: idempotencyKey,
                attachments: attachments),
            generation: self.generation)
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        self.historyCalls += 1
        await self.historyGate?.wait()
        self.historyReturns += 1
        if let historyPayload { return historyPayload }
        throw URLError(.notConnectedToInternet)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey _: String,
        agentID _: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        self.catalogLoads += 1
        return OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            permissionMutationAvailable: true,
            sessionSettingsCASAvailable: true)
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func release() async {
        await self.sendGate?.open()
        await self.historyGate?.open()
        await self.validationGate?.open()
    }
}

@MainActor
private struct NativeSubmissionFixture {
    let target: OpenClawNativeSessionRef
    let defaults: UserDefaults
    let suite: String
    let transport: NativeSubmissionTransport
    let vm: OpenClawChatViewModel

    init(
        transport: NativeSubmissionTransport,
        outbox: (any OpenClawChatCommandOutbox)? = nil,
        sessionKey: String = "agent:agent-a:main",
        agentID: String = "agent-a") throws
    {
        self.target = OpenClawNativeSessionRef(
            owner: OpenClawNativeOwnerRef(gatewayID: "gateway-a", profileID: "profile-a"),
            agentID: agentID,
            sessionKey: sessionKey)
        self.suite = "ChatExternalSubmissionTests.\(UUID().uuidString)"
        self.defaults = try #require(UserDefaults(suiteName: self.suite))
        self.transport = transport
        self.vm = OpenClawChatViewModel(
            sessionKey: self.target.sessionKey,
            transport: transport,
            activeAgentId: self.target.agentID,
            sessionRoutingContract: NativeSubmissionTransport.contract,
            haptics: OpenClawChatHaptics(performer: { _ in }),
            outbox: outbox,
            modelPickerStore: ChatModelPickerStore(defaults: self.defaults))
        self.vm.sessions = try [JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: JSONSerialization.data(withJSONObject: [
                "key": sessionKey, "agentId": agentID, "sessionId": "session-a",
                "permissionMode": "guarded", "toolOverrides": ["webSearch": false],
            ]))]
        self.vm.healthOK = true
        self.vm.readySessionMetadataGeneration = self.vm.sessionMetadataGeneration
    }

    func prepare() async {
        await self.vm.loadComposerCapabilities()
    }

    func request(_ message: String = "external text") -> OpenClawChatExternalSubmission {
        OpenClawChatExternalSubmission(target: self.target, message: message)
    }

    func close() async {
        await self.transport.release()
        self.vm.detachTransport()
        self.defaults.removePersistentDomain(forName: self.suite)
    }
}

@MainActor
private struct ChatExternalSubmissionTests {
    @Test(arguments: ["idle", "reply", "attachment", "staging", "pending", "sending", "submitting"])
    func `native reopen can retain only idle text`(state: String) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        fixture.vm.input = "retained text"
        switch state {
        case "reply":
            fixture.vm.setReplyTarget(messageID: UUID(), text: "quoted turn", senderLabel: "User")
        case "attachment":
            fixture.vm.attachments = [OpenClawPendingAttachment(
                url: nil, data: Data([1]), fileName: "draft.png", mimeType: "image/png", preview: nil)]
        case "staging": fixture.vm.attachmentStagingCount = 1
        case "pending": fixture.vm.pendingRuns.insert("running")
        case "sending": fixture.vm.isSending = true
        case "submitting": fixture.vm.isSubmittingDraft = true
        default: break
        }
        #expect(fixture.vm.canPreserveIdleTextDraft == (state == "idle"))
        #expect(fixture.vm.input == "retained text")
        await fixture.close()
    }

    @Test(arguments: ["not_started", "may_have_executed", "unknown", "missing", "malformed"])
    func `profile mismatch needs explicit non execution evidence and never replays`(execution: String) async throws {
        var details = ["reason": AnyCodable("EXPECTED_PROFILE_MISMATCH")]
        if execution != "missing" {
            details["execution"] = execution == "malformed" ? AnyCodable(17) : AnyCodable(execution)
        }
        let error = GatewayResponseError(
            method: "chat.send", code: "INVALID_REQUEST", message: "Account changed", details: details)
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(responseError: error))
        await fixture.prepare()
        fixture.vm.input = "preserved draft"
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let outcome = await fixture.vm.submit(invocation, using: route)
        if execution == "not_started" {
            if case .notDispatched = outcome {} else { Issue.record("Admission rejection proves no execution") }
        } else {
            if case .uncertain = outcome {} else { Issue.record("Handler entry cannot prove non-delivery") }
        }
        #expect(await fixture.vm.submit(invocation, using: route) == outcome)
        #expect(await fixture.transport.sent.count == 1)
        #expect(fixture.vm.input == "preserved draft")
        #expect(fixture.vm.pendingRunCount == 0)
        await fixture.close()
    }

    @Test func `later non execution evidence cannot replace a known acknowledgement`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let accepted = await fixture.vm.submit(invocation, using: route)
        #expect(accepted == .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
        await fixture.transport.setResponseError(GatewayResponseError(
            method: "chat.send",
            code: "INVALID_REQUEST",
            message: "Account changed",
            details: [
                "reason": AnyCodable("EXPECTED_PROFILE_MISMATCH"),
                "execution": AnyCodable("not_started"),
            ]))
        #expect(await fixture.vm.submit(invocation, using: route) == accepted)
        #expect(await fixture.transport.sent.count == 1)
        await fixture.close()
    }

    @Test func `route loss after dispatch preserves a decoded acknowledgement`() async throws {
        let gate = NativeSubmissionGate()
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            onAcceptedRun: { observedSessions.append($0) }, sendGate: gate))
        await fixture.prepare()
        fixture.vm.sessionId = "session-a"
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let pending = Task { await fixture.vm.submit(invocation, using: route) }
        do {
            try await waitUntil("external send entered") { await gate.entered }
            let retainedRuns = fixture.vm.pendingRuns
            fixture.vm.handleTransportEvent(.routeUnavailable(reason: "Selected account lost."))
            await gate.open()
            #expect(await pending.value == .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
            #expect(fixture.vm.pendingRuns == retainedRuns)
            #expect(fixture.vm.errorText == "Selected account lost.")
            #expect(!fixture.vm.healthOK)
            #expect(await fixture.transport.sent.count == 1)
            #expect(observedSessions == ["session-a"])
        } catch {
            await gate.open()
            _ = await pending.value
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .rejected, .uncertain], [false, true])
    func `external send never consumes composer`(
        response: NativeSubmissionTransport.Response,
        composerCapabilities: Bool) async throws
    {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response, supportsComposerCapabilities: composerCapabilities))
        await fixture.prepare()
        let vm = fixture.vm
        let request = fixture.request("identical text")
        vm.input = request.message
        vm.setReplyTarget(messageID: UUID(), text: "not part of this action", senderLabel: "User")
        let reply = vm.replyTarget
        let attachment = OpenClawPendingAttachment(
            url: nil, data: Data([1, 2, 3]), fileName: "draft.png", mimeType: "image/png", preview: nil)
        vm.attachments = [attachment]
        let revision = vm.composerRevision(for: vm.sessionKey)
        let route = await fixture.transport.route(fixture.target)
        let result = await vm.submit(request, using: route)

        #expect(vm.input == request.message)
        #expect(vm.replyTarget == reply)
        #expect(vm.attachments.map(\.id) == [attachment.id])
        #expect(vm.composerRevision(for: vm.sessionKey) == revision)
        let sent = await fixture.transport.sent
        #expect(sent.count == 1)
        #expect(sent.first?.text == request.message)
        #expect(sent.first?.attachments.isEmpty == true)
        #expect(sent.first?.key == fixture.target.sessionKey)
        #expect(sent.first?.agent == fixture.target.agentID)
        #expect(sent.first?.settings == OpenClawChatSessionSettingsExpectation(
            permissionMode: .guarded,
            toolOverrides: OpenClawChatSessionToolOverrides(webSearch: false)))
        #expect(await fixture.transport.catalogLoads == (composerCapabilities ? 1 : 0))
        switch response {
        case .accepted:
            #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
        case .rejected:
            guard case .rejected = result else {
                Issue.record("Expected rejection")
                break
            }
        case .uncertain:
            guard case .uncertain = result else {
                Issue.record("Expected uncertain delivery")
                break
            }
        }
        await fixture.close()
    }

    @Test(arguments: ["capability", "stale", "missing", "wrong agent", "missing agent", "placeholder", "alias"])
    func `external send requires verified selected metadata`(failure: String) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            supportsSessionSettingsCAS: failure != "capability"))
        await fixture.prepare()
        switch failure {
        case "stale":
            fixture.vm.invalidateSessionMetadataReadiness()
        case "missing":
            fixture.vm.sessions = []
        case "wrong agent":
            fixture.vm.sessions[0].agentId = "agent-b"
        case "missing agent":
            fixture.vm.sessions[0].agentId = nil
        case "placeholder":
            fixture.vm.sessions = [.placeholder(key: fixture.target.sessionKey)]
        case "alias":
            var alias = OpenClawChatSessionEntry.placeholder(key: "main")
            alias.agentId = fixture.target.agentID
            fixture.vm.sessions = [alias]
        default:
            break
        }
        fixture.vm.input = "keep draft"
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(fixture.request(), using: route)
        if case .notDispatched = result {} else { Issue.record("Unverified settings must prevent dispatch") }
        #expect(await fixture.transport.sent.isEmpty)
        #expect(await fixture.transport.catalogLoads == 0)
        #expect(fixture.vm.input == "keep draft")
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `global session settings belong to the explicit agent`(includeSelected: Bool) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(), sessionKey: "global")
        let selected = fixture.vm.sessions[0]
        var other = selected
        other.agentId = "agent-b"
        other.permissionMode = .full
        other.toolOverrides = nil
        fixture.vm.sessions = includeSelected ? [other, selected] : [other]
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(request, using: route)
        let sent = await fixture.transport.sent
        if includeSelected {
            #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
            #expect(sent.count == 1)
            #expect(sent.first?.key == "global")
            #expect(sent.first?.agent == fixture.target.agentID)
            #expect(sent.first?.settings == OpenClawChatSessionSettingsExpectation(
                permissionMode: .guarded, toolOverrides: .init(webSearch: false)))
        } else {
            if case .notDispatched = result {} else { Issue.record("Another global owner supplied settings") }
            #expect(sent.isEmpty)
        }
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `canonically equivalent owner spelling cannot supply settings`(changeAgent: Bool) async throws {
        let fixture = try NativeSubmissionFixture(
            transport: NativeSubmissionTransport(), sessionKey: "global-\u{e9}", agentID: "agent-\u{e9}")
        if changeAgent {
            fixture.vm.sessions[0].agentId = "agent-e\u{301}"
        } else {
            fixture.vm.sessions[0].key = "global-e\u{301}"
        }
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(fixture.request(), using: route)
        if case .notDispatched = result {} else { Issue.record("Selected metadata requires exact UTF8") }
        #expect(await fixture.transport.sent.isEmpty)
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .rejected, .uncertain])
    func `same invocation joins and retains its original execution`(response: NativeSubmissionTransport
        .Response) async throws
    {
        let gate = NativeSubmissionGate()
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response,
            onAcceptedRun: { observedSessions.append($0) },
            sendGate: gate))
        await fixture.prepare()
        fixture.vm.sessionId = "session-a"
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let replacement = NativeSubmissionTransport()
        let replacementRoute = await replacement.route(fixture.target)
        let first = Task { await fixture.vm.submit(request, using: route) }
        var duplicate: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("native send entered") { await gate.entered }
            #expect(observedSessions.isEmpty)
            let validations = await fixture.transport.validationCalls
            let waiter = Task { await fixture.vm.submit(request, using: replacementRoute) }
            duplicate = waiter
            try await waitUntil("duplicate joined the original route") {
                await fixture.transport.validationCalls > validations
            }
            await gate.open()
            let expected = await first.value
            switch response {
            case .accepted:
                #expect(expected == .accepted(runID: "remote-\(request.operationID.uuidString)"))
            case .rejected:
                if case .rejected = expected {} else { Issue.record("Expected rejection") }
            case .uncertain:
                if case .uncertain = expected {} else { Issue.record("Expected uncertain delivery") }
            }
            #expect(await waiter.value == expected)
            #expect(await fixture.vm.submit(request, using: replacementRoute) == expected)
            #expect(await fixture.transport.sent.count == 1)
            #expect(await replacement.sent.isEmpty)
            #expect(observedSessions == (response == .accepted ? ["session-a"] : []))
        } catch {
            await fixture.close()
            _ = await first.value
            _ = await duplicate?.value
            throw error
        }
        await fixture.close()
    }

    @Test
    func `acceptance does not wait for history or terminal run`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(historyGate: gate))
        await fixture.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(request, using: route)
        #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
        #expect(fixture.vm.pendingRunCount == 1)
        #expect(!fixture.vm.isSending)
        await fixture.close()
    }

    @Test(arguments: ["committed", "empty-history", "empty-run"])
    func `aborted timeout receipt retains its operation but history owns the user turn`(
        scenario: String) async throws
    {
        let emptyRunID = scenario == "empty-run"
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: "timeout", ackRunID: emptyRunID ? "" : "admitted-run", ackSummary: "aborted",
            onAcceptedRun: { observedSessions.append($0) }))
        await fixture.prepare()
        fixture.vm.sessionId = "session-a"
        let messages = scenario == "committed"
            ? #"[{"role":"user","content":[{"type":"text","text":"external text"}],"idempotencyKey":"admitted-run:user"}]"#
            : "[]"
        await fixture.transport.setHistoryPayload(try JSONDecoder().decode(
            OpenClawChatHistoryPayload.self,
            from: Data(#"{"sessionKey":"\#(fixture.target.sessionKey)","messages":\#(messages)}"#.utf8)))
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(invocation, using: route)
        if emptyRunID {
            if case .uncertain = result {} else { Issue.record("An empty run ID cannot establish a continuation") }
        } else {
            #expect(result == .accepted(runID: "admitted-run"))
            do {
                try await waitUntil("aborted run reconciled") {
                    await MainActor.run { fixture.vm.pendingRunCount == 0 }
                }
                #expect(fixture.vm.errorText == nil)
                #expect(fixture.vm.messages.contains { $0.role == "user" } == (scenario == "committed"))
            } catch {
                await fixture.close()
                throw error
            }
        }
        #expect(await fixture.vm.submit(invocation, using: route) == result)
        #expect(await fixture.transport.sent.count == 1)
        #expect(observedSessions == (emptyRunID ? [] : ["session-a"]))
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `retired native reconciliation cannot change the retained presentation`(duringHistory: Bool) async throws {
        let gate = NativeSubmissionGate()
        let transport = NativeSubmissionTransport(
            ackStatus: "ok",
            historyGate: duringHistory ? gate : nil,
            validationGate: duringHistory ? nil : gate,
            validationGateCall: 4)
        let fixture = try NativeSubmissionFixture(transport: transport)
        await fixture.prepare()
        await transport.setHistoryPayload(try JSONDecoder().decode(
            OpenClawChatHistoryPayload.self,
            from: Data("""
            {"sessionKey":"\(fixture.target.sessionKey)","messages":[
              {"role":"assistant","content":[{"type":"text","text":"stale history"}],"timestamp":1}
            ]}
            """.utf8)))
        let invocation = fixture.request()
        let route = await transport.route(fixture.target)
        #expect(await fixture.vm.submit(invocation, using: route) ==
            .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
        do {
            try await waitUntil("reconciliation suspended") { await gate.entered }
            let messages = fixture.vm.messages.map(\.id)
            let pending = fixture.vm.pendingRuns
            let validations = await transport.validationCalls
            await transport.invalidate()
            fixture.vm.errorText = "retained presentation"
            await gate.open()
            if duringHistory {
                try await waitUntil("history returned through route fence") {
                    let returned = await transport.historyReturns
                    let checked = await transport.validationCalls
                    return returned == 1 && checked > validations
                }
            }
            let readback = await fixture.vm.submit(invocation, using: route)
            if case .uncertain = readback {} else { Issue.record("Expired readback requires authority") }
            #expect(fixture.vm.messages.map(\.id) == messages)
            #expect(fixture.vm.pendingRuns == pending)
            #expect(fixture.vm.errorText == "retained presentation")
            #expect(await transport.historyCalls == (duringHistory ? 1 : 0))
            #expect(await transport.sent.count == 1)
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `route invalidation before or after dispatch is distinguished`(afterDispatch: Bool) async throws {
        let gate = NativeSubmissionGate()
        let transport = NativeSubmissionTransport(
            sendGate: afterDispatch ? gate : nil,
            validationGate: afterDispatch ? nil : gate)
        let fixture = try NativeSubmissionFixture(transport: transport)
        await fixture.prepare()
        let request = fixture.request()
        let route = await transport.route(fixture.target)
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("native route suspended") { await gate.entered }
            await transport.invalidate()
            await gate.open()
            let result = await task.value
            if afterDispatch {
                guard case .uncertain = result else {
                    Issue.record("Lost post-dispatch authority must stay uncertain")
                    await fixture.close()
                    return
                }
                let retry = await fixture.vm.submit(request, using: route)
                if case .uncertain = retry {} else { Issue.record("Stale readback cannot claim acceptance") }
            } else {
                guard case .notDispatched = result else {
                    Issue.record("Expected known pre-dispatch refusal")
                    await fixture.close()
                    return
                }
            }
            #expect(await transport.sent.count == (afterDispatch ? 1 : 0))
            #expect(fixture.vm.input.isEmpty)
            #expect(fixture.vm.pendingRunCount == (afterDispatch ? 1 : 0))
        } catch {
            await fixture.close()
            _ = await task.value
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: ["accepted", "failed patch", "changed lease", "stale metadata", "wrong agent"])
    func `external send waits for settings and revalidates the owner`(completion: String) async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let target = fixture.vm.currentModelPatchTarget()
        let patchID = fixture.vm.reserveSessionSettingsRequest(for: target)
        fixture.vm.enqueueSessionSettingsPatch(requestID: patchID, target: target) { _ in
            await gate.wait()
            if completion == "failed patch" {
                await fixture.vm.recordCapabilityPatchFailure(
                    NSError(
                        domain: "SettingsTest",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Settings rejected"]),
                    target: target,
                    outboxScope: nil,
                    updateVisibleState: true)
            } else {
                fixture.vm.sessions[0].permissionMode = .full
                fixture.vm.sessions[0].toolOverrides = nil
            }
        }
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("submission waits for settings") { await MainActor.run { fixture.vm.isSending } }
            #expect(await fixture.transport.sent.isEmpty)
            switch completion {
            case "changed lease": await fixture.transport.invalidate()
            case "stale metadata": fixture.vm.invalidateSessionMetadataReadiness()
            case "wrong agent": fixture.vm.sessions[0].agentId = "agent-b"
            default: break
            }
            await gate.open()
            let result = await task.value
            let sent = await fixture.transport.sent
            switch completion {
            case "accepted":
                #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
                #expect(sent.count == 1)
                #expect(sent.first?.settings == OpenClawChatSessionSettingsExpectation(
                    permissionMode: .full, toolOverrides: nil))
            case "failed patch":
                if case .rejected = result {} else { Issue.record("Failed settings must reject submission") }
                #expect(sent.isEmpty)
            default:
                if case .notDispatched = result {} else { Issue.record("Changed ownership must prevent dispatch") }
                #expect(sent.isEmpty)
            }
        } catch {
            await gate.open()
            await fixture.close()
            _ = await task.value
            throw error
        }
        await fixture.close()
    }

    @Test
    func `cancellation while waiting for settings never dispatches or restores external text`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let target = fixture.vm.currentModelPatchTarget()
        let patchID = fixture.vm.reserveSessionSettingsRequest(for: target)
        fixture.vm.enqueueSessionSettingsPatch(requestID: patchID, target: target) { _ in await gate.wait() }
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("submission waits for settings") { await MainActor.run { fixture.vm.isSending } }
            task.cancel()
            await gate.open()
            #expect(await task.value == .cancelled)
            #expect(await fixture.vm.submit(request, using: route) == .cancelled)
            #expect(await fixture.transport.sent.isEmpty)
            #expect(fixture.vm.input.isEmpty)
            #expect(fixture.vm.pendingRunCount == 0)
        } catch {
            await gate.open()
            await fixture.close()
            _ = await task.value
            throw error
        }
        await fixture.close()
    }

    @Test
    func `cancelling A duplicate waiter does not cancel the invocation`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let target = fixture.vm.currentModelPatchTarget()
        let patchID = fixture.vm.reserveSessionSettingsRequest(for: target)
        fixture.vm.enqueueSessionSettingsPatch(requestID: patchID, target: target) { _ in await gate.wait() }
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let first = Task { await fixture.vm.submit(request, using: route) }
        var duplicate: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("submission waits for settings") { await MainActor.run { fixture.vm.isSending } }
            let validations = await fixture.transport.validationCalls
            let waiter = Task { await fixture.vm.submit(request, using: route) }
            duplicate = waiter
            try await waitUntil("duplicate joined the original route") {
                await fixture.transport.validationCalls > validations
            }
            waiter.cancel()
            await gate.open()
            let expected = OpenClawChatSubmissionOutcome.accepted(runID: "remote-\(request.operationID.uuidString)")
            #expect(await first.value == expected)
            #expect(await waiter.value == expected)
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await gate.open()
            await fixture.close()
            _ = await first.value
            _ = await duplicate?.value
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .uncertain])
    func `cancellation after dispatch cannot erase acceptance or allow replay`(
        response: NativeSubmissionTransport.Response) async throws
    {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response,
            sendGate: gate))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let first = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("native send entered") { await gate.entered }
            first.cancel()
            await gate.open()
            let result = await first.value
            if case .accepted = response {
                #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
            } else if case .uncertain = result {
                #expect(fixture.vm.pendingRunCount == 0)
            } else {
                Issue.record("Post-dispatch cancellation cannot prove non-delivery")
            }
            #expect(await fixture.vm.submit(request, using: route) == result)
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await fixture.close()
            _ = await first.value
            throw error
        }
        await fixture.close()
    }

    @Test
    func `new settings mutation during final route validation prevents dispatch`() async throws {
        let validation = NativeSubmissionGate()
        let patch = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            validationGate: validation,
            validationGateCall: 2))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("final route validation entered") { await validation.entered }
            let target = fixture.vm.currentModelPatchTarget()
            let patchID = fixture.vm.reserveSessionSettingsRequest(for: target)
            fixture.vm.enqueueSessionSettingsPatch(requestID: patchID, target: target) { _ in await patch.wait() }
            await validation.open()
            let result = await task.value
            if case .notDispatched = result {} else { Issue.record("A newer settings mutation must hold delivery") }
            #expect(await fixture.transport.sent.isEmpty)
        } catch {
            await patch.open()
            await fixture.close()
            _ = await task.value
            throw error
        }
        await patch.open()
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `offline or unrestored outbox never accepts external persistence`(offline: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("native-actions-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gateway-a")
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(), outbox: outbox)
        await fixture.prepare()
        fixture.vm.healthOK = !offline
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(request, using: route)
        guard case .notDispatched = result else {
            Issue.record("External actions cannot queue in a Gateway-only namespace")
            await fixture.close()
            return
        }
        #expect(await outbox.loadCommands().isEmpty)
        #expect(await fixture.transport.sent.isEmpty)
        #expect(fixture.vm.input.isEmpty)
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `restored outbox preserves FIFO and never stores ambiguous external work`(hasBacklog: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("native-actions-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let outbox = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gateway-a")
        let fixture = try NativeSubmissionFixture(
            transport: NativeSubmissionTransport(response: .uncertain),
            outbox: outbox)
        await fixture.prepare()
        if hasBacklog {
            #expect(await outbox.enqueueCommand(OpenClawChatOutboxCommand(
                id: "older-message",
                sessionKey: fixture.target.sessionKey,
                text: "first message",
                thinking: "off",
                createdAt: Date().timeIntervalSince1970,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
        }
        fixture.vm.healthOK = false
        fixture.vm.restoreOutboxMessages(session: fixture.vm.currentSessionSnapshot())
        do {
            try await waitUntil("outbox restored") { await MainActor.run { fixture.vm.hasRestoredOutboxMessages } }
            fixture.vm.healthOK = true
            let route = await fixture.transport.route(fixture.target)
            let result = await fixture.vm.submit(fixture.request(), using: route)
            if hasBacklog {
                if case .notDispatched = result {} else { Issue.record("External work must not overtake the outbox") }
                #expect(await fixture.transport.sent.isEmpty)
                #expect(await outbox.loadCommands().map(\.id) == ["older-message"])
            } else {
                if case .uncertain = result {} else { Issue.record("Expected ambiguous delivery") }
                #expect(await fixture.transport.sent.count == 1)
                #expect(await outbox.loadCommands().isEmpty)
            }
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: ["started", "in_flight", "ok", "pending", "unexpected", ""])
    func `acceptance requires known gateway status`(status: String) async throws {
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: status, onAcceptedRun: { observedSessions.append($0) }))
        await fixture.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(request, using: route)
        if ["started", "in_flight", "ok"].contains(status) {
            #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
        } else if case .uncertain = result {
            #expect(fixture.vm.pendingRunCount == 0)
        } else {
            Issue.record("An unknown ACK status cannot establish acceptance")
        }
        #expect(observedSessions == (["started", "in_flight", "ok"].contains(status) ? [nil] : []))
        await fixture.close()
    }

    @Test
    func `accepted observer precedes presentation validation and retains the send session`() async throws {
        let send = NativeSubmissionGate()
        let presentation = NativeSubmissionGate()
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            onAcceptedRun: { observedSessions.append($0) },
            sendGate: send, validationGate: presentation, validationGateCall: 3))
        await fixture.prepare()
        fixture.vm.sessionId = "session-a"
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let pending = Task { await fixture.vm.submit(invocation, using: route) }
        do {
            try await waitUntil("send suspended before ACK") { await send.entered }
            #expect(observedSessions.isEmpty)
            fixture.vm.sessionId = "session-successor"
            await send.open()
            try await waitUntil("presentation validation suspended") { await presentation.entered }
            #expect(observedSessions == ["session-a"])
            await presentation.open()
            #expect(await pending.value == .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
            #expect(observedSessions == ["session-a"])
        } catch {
            await fixture.close()
            _ = await pending.value
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: ["started", "in_flight", "ok", "aborted", "timeout", "error", "pending", "blank-run"])
    func `composer observes only confirmed run acknowledgements`(scenario: String) async throws {
        var observedSessions: [String?] = []
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: scenario == "aborted" ? "timeout" : scenario == "blank-run" ? "started" : scenario,
            ackRunID: scenario == "blank-run" ? " \n\t " : "remote-run",
            ackSummary: scenario == "aborted" ? "aborted" : nil,
            onAcceptedRun: { observedSessions.append($0) }))
        await fixture.prepare()
        fixture.vm.sessionId = "session-a"
        fixture.vm.input = "composer text"
        fixture.vm.send()
        do {
            try await waitUntil("composer ACK handled") {
                let count = await fixture.transport.sent.count
                return await MainActor.run { count == 1 && !fixture.vm.isSubmittingDraft }
            }
            #expect(observedSessions == (
                ["started", "in_flight", "ok", "aborted"].contains(scenario) ? ["session-a"] : []))
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test
    func `empty run ID does not establish acceptance`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(ackRunID: ""))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(fixture.request(), using: route)
        if case .uncertain = result {} else { Issue.record("An empty run ID cannot establish acceptance") }
        #expect(fixture.vm.pendingRunCount == 0)
        await fixture.close()
    }

    @Test
    func `expired lease cannot read back accepted receipt`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        #expect(await fixture.vm.submit(request, using: route) ==
            .accepted(runID: "remote-\(request.operationID.uuidString)"))
        await fixture.transport.invalidate()
        let replacement = NativeSubmissionTransport()
        let replacementRoute = await replacement.route(fixture.target)
        let result = await fixture.vm.submit(request, using: replacementRoute)
        if case .uncertain = result {} else { Issue.record("Readback requires current account authority") }
        #expect(await fixture.transport.sent.count == 1)
        #expect(await replacement.sent.isEmpty)
        await fixture.close()
    }

    @Test
    func `another view model cannot take ownership of an invocation`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        let replacement = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        await replacement.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let expected = await fixture.vm.submit(request, using: route)
        let replacementRoute = await replacement.transport.route(replacement.target)
        let result = await replacement.vm.submit(request, using: replacementRoute)
        if case .uncertain = result {} else {
            Issue.record("A different chat owner cannot read or replay this invocation")
        }
        #expect(await replacement.transport.sent.isEmpty)
        #expect(await fixture.vm.submit(request, using: route) == expected)
        #expect(await fixture.transport.sent.count == 1)
        await replacement.close()
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `selected owner and session cannot be substituted`(changeOwner: Bool) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let other = OpenClawNativeSessionRef(
            owner: changeOwner
                ? OpenClawNativeOwnerRef(gatewayID: "gateway-b", profileID: "profile-b")
                : fixture.target.owner,
            agentID: "agent-a",
            sessionKey: changeOwner ? fixture.target.sessionKey : "agent:agent-a:other")
        let request = OpenClawChatExternalSubmission(target: other, message: "do not retarget")
        let route = await fixture.transport.route(changeOwner ? fixture.target : other)
        let result = await fixture.vm.submit(request, using: route)
        if case .notDispatched = result {} else { Issue.record("A mismatched selection must never dispatch") }
        #expect(await fixture.transport.sent.isEmpty)
        #expect(fixture.vm.sessionKey == fixture.target.sessionKey)
        await fixture.close()
    }

    @Test
    func `known non dispatch stays settled when readiness changes`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        fixture.vm.healthOK = false
        let result = await fixture.vm.submit(request, using: route)
        if case .notDispatched = result {} else { Issue.record("Offline invocation must not dispatch") }
        fixture.vm.healthOK = true
        #expect(await fixture.vm.submit(request, using: route) == result)
        #expect(await fixture.transport.sent.isEmpty)
        let next = fixture.request()
        #expect(next.operationID != request.operationID)
        #expect(await fixture.vm
            .submit(next, using: route) == .accepted(runID: "remote-\(next.operationID.uuidString)"))
        #expect(await fixture.transport.sent.count == 1)
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .rejected, .uncertain])
    func `distinct invocations do not exhaust the chat owner`(response: NativeSubmissionTransport
        .Response) async throws
    {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response,
            ackStatus: "ok"))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let invocations = (0..<130).map { _ in fixture.request() }
        var firstResult: OpenClawChatSubmissionOutcome?
        do {
            for invocation in invocations {
                let result = await fixture.vm.submit(invocation, using: route)
                if firstResult == nil { firstResult = result }
                switch response {
                case .accepted:
                    #expect(result == .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
                case .rejected:
                    if case .rejected = result {} else { Issue.record("Expected rejection") }
                case .uncertain:
                    if case .uncertain = result {} else { Issue.record("Expected uncertain delivery") }
                }
                try await waitUntil("invocation settled") { await MainActor.run { fixture.vm.pendingRunCount == 0 } }
            }
            #expect(Set(invocations.map(\.operationID)).count == invocations.count)
            #expect(await fixture.vm.submit(invocations[0], using: route) == firstResult)
            #expect(await fixture.transport.sent.count == invocations.count)
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test
    func `settlement releases execution captures and the view model does not retain invocations`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(response: .uncertain))
        await fixture.prepare()
        weak var executionLifetime: NativeSubmissionLifetime?
        weak var releasedInvocation: OpenClawChatExternalSubmission?
        func perform() async -> OpenClawChatExternalSubmission {
            let lifetime = NativeSubmissionLifetime()
            executionLifetime = lifetime
            let route = await fixture.transport.route(fixture.target, sendLifetime: lifetime)
            let request = fixture.request()
            let result = await fixture.vm.submit(request, using: route)
            if case .uncertain = result {} else { Issue.record("Expected uncertain delivery") }
            return request
        }
        var invocation: OpenClawChatExternalSubmission? = await perform()
        releasedInvocation = invocation
        #expect(executionLifetime == nil)
        invocation = nil
        #expect(releasedInvocation == nil)
        #expect(await fixture.transport.sent.count == 1)
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .uncertain], [false, true])
    func `composer still consumes or restores its own draft`(
        response: NativeSubmissionTransport.Response,
        composerCapabilities: Bool) async throws
    {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response, supportsComposerCapabilities: composerCapabilities))
        await fixture.prepare()
        fixture.vm.input = "composer text"
        fixture.vm.setReplyTarget(messageID: UUID(), text: "quoted text", senderLabel: "User")
        let reply = fixture.vm.replyTarget
        fixture.vm.send()
        do {
            try await waitUntil("composer submission completed") {
                let sent = await fixture.transport.sent.count
                return await MainActor.run { sent == 1 && !fixture.vm.isSubmittingDraft }
            }
            let sent = await fixture.transport.sent
            #expect(sent.first?.text == "> **User:** quoted text\n\ncomposer text")
            switch response {
            case .accepted:
                #expect(fixture.vm.input.isEmpty)
                #expect(fixture.vm.replyTarget == nil)
            case .uncertain:
                #expect(fixture.vm.input == "composer text")
                #expect(fixture.vm.replyTarget == reply)
            case .rejected:
                break
            }
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }
}
