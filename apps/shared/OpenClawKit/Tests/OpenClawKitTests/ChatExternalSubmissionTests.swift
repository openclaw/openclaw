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

@MainActor
private final class NativeSubmissionPresentation {
    var isCurrent = true
}

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

    enum TargetedHistoryReply: Sendable {
        case snapshot
        case reconciliation
        case held(OpenClawChatHistoryPayload, NativeSubmissionGate)
    }

    struct HistoryRequest: Sendable {
        let key: String
        let agent: String?
    }

    static let contract = "per-sender|main|agent-a"
    nonisolated let supportsComposerCapabilities: Bool
    let supportsSessionSettingsCAS: Bool
    let sendGate: NativeSubmissionGate?
    let historyGate: NativeSubmissionGate?
    let snapshotGate: NativeSubmissionGate?
    let validationGate: NativeSubmissionGate?
    let settingsPatchGate: NativeSubmissionGate?
    let resetGate: NativeSubmissionGate?
    let completionGate: NativeSubmissionGate?
    let response: Response
    let ackStatus: String
    let ackRunID: String?
    let ackSummary: String?
    let validationGateCall: Int
    private var responseError: GatewayResponseError?
    private let retireOnResponseError: Bool
    private var generation = 0
    private(set) var validationCalls = 0
    private(set) var catalogLoads = 0
    private(set) var sent: [Sent] = []
    private(set) var historyCalls = 0
    private(set) var historyReturns = 0
    private var historyPayload: OpenClawChatHistoryPayload?
    private var sessionsPayload: OpenClawChatSessionsListResponse?
    private(set) var sessionListCalls = 0
    private(set) var resetKeys: [String] = []
    private var snapshotData: Data?
    private var snapshotUnavailable = false
    private var targetedHistoryReplies: [TargetedHistoryReply] = []
    private(set) var targetedHistoryRequests: [HistoryRequest] = []
    private(set) var targetedHistoryReturns: [Int] = []
    private(set) var wireEvents: [String] = []

    init(
        response: Response = .accepted,
        ackStatus: String = "started",
        ackRunID: String? = nil,
        ackSummary: String? = nil,
        sendGate: NativeSubmissionGate? = nil,
        historyGate: NativeSubmissionGate? = nil,
        snapshotGate: NativeSubmissionGate? = nil,
        validationGate: NativeSubmissionGate? = nil,
        settingsPatchGate: NativeSubmissionGate? = nil,
        resetGate: NativeSubmissionGate? = nil,
        completionGate: NativeSubmissionGate? = nil,
        validationGateCall: Int = 1,
        supportsComposerCapabilities: Bool = false,
        supportsSessionSettingsCAS: Bool = true,
        responseError: GatewayResponseError? = nil,
        retireOnResponseError: Bool = false)
    {
        self.response = response
        self.ackStatus = ackStatus
        self.ackRunID = ackRunID
        self.ackSummary = ackSummary
        self.sendGate = sendGate
        self.historyGate = historyGate
        self.snapshotGate = snapshotGate
        self.validationGate = validationGate
        self.settingsPatchGate = settingsPatchGate
        self.resetGate = resetGate
        self.completionGate = completionGate
        self.validationGateCall = validationGateCall
        self.supportsComposerCapabilities = supportsComposerCapabilities
        self.supportsSessionSettingsCAS = supportsSessionSettingsCAS
        self.responseError = responseError
        self.retireOnResponseError = retireOnResponseError
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

    func setSessionsPayload(_ payload: OpenClawChatSessionsListResponse) {
        self.sessionsPayload = payload
    }

    func setSnapshotData(_ data: Data) {
        self.snapshotData = data
    }

    func setSnapshotUnavailable() {
        self.snapshotUnavailable = true
    }

    func setTargetedHistoryReplies(_ replies: [TargetedHistoryReply]) {
        self.targetedHistoryReplies = replies
    }

    private func requestTargetedHistory(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatHistoryPayload
    {
        // Reserve the scripted reply before suspension. The wire ledger, not the
        // reply label, proves whether this read preceded or followed actual dispatch.
        self.targetedHistoryRequests.append(HistoryRequest(key: sessionKey, agent: agentID))
        let ordinal = self.targetedHistoryRequests.count
        let reply = self.targetedHistoryReplies.isEmpty ? .snapshot : self.targetedHistoryReplies.removeFirst()
        self.wireEvents.append("history:\(ordinal):started")
        let result: OpenClawChatHistoryPayload
        switch reply {
        case .snapshot:
            await self.snapshotGate?.wait()
            if self.snapshotUnavailable { throw URLError(.notConnectedToInternet) }
            if let snapshotData {
                result = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: snapshotData)
            } else {
                result = OpenClawChatHistoryPayload(
                    sessionKey: sessionKey, sessionId: "session-a", messages: [], thinkingLevel: nil,
                    sessionInfo: OpenClawChatSessionInfo(
                        hasActiveRun: false, key: sessionKey, agentId: agentID, sessionId: "session-a",
                        permissionMode: .guarded, toolOverrides: .init(webSearch: false)))
            }
        case .reconciliation:
            result = try await self.requestHistory(sessionKey: sessionKey)
        case let .held(payload, gate):
            await gate.wait()
            result = payload
        }
        self.targetedHistoryReturns.append(ordinal)
        self.wireEvents.append("history:\(ordinal):returned")
        return result
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
                requestTargetedHistory: { key, agent in
                    try await self.requestTargetedHistory(sessionKey: key, agentID: agent)
                },
                sessionRoutingContract: Self.contract,
                supportsSessionSettingsCAS: self.supportsSessionSettingsCAS),
            accountIsCurrent: { await self.validate(generation: generation) },
            presentationIsCurrent: { true })
    }

    private func validate(generation: Int) async -> Bool {
        self.validationCalls += 1
        if self.validationCalls >= self.validationGateCall {
            await self.validationGate?.wait()
        }
        return self.generation == generation
    }

    private func deliver(_ message: Sent, generation: Int) async throws -> OpenClawChatSendResponse {
        self.wireEvents.append("send:\(message.id)")
        self.sent.append(message)
        await self.sendGate?.wait()
        guard self.generation == generation else { throw CancellationError() }
        if let responseError {
            if self.retireOnResponseError { self.invalidate() }
            throw responseError
        }
        switch self.response {
        case .accepted:
            return OpenClawChatSendResponse(
                runId: self.ackRunID ?? "remote-\(message.id)",
                status: self.ackStatus,
                summary: self.ackSummary)
        case .rejected:
            return OpenClawChatSendResponse(runId: message.id, status: "error")
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

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        self.sessionListCalls += 1
        if let sessionsPayload { return sessionsPayload }
        throw NSError(
            domain: "OpenClawChatTransport", code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }

    func resetSession(sessionKey: String) async throws {
        guard let resetGate else {
            throw NSError(
                domain: "OpenClawChatTransport", code: 0,
                userInfo: [NSLocalizedDescriptionKey: "sessions.reset not supported by this transport"])
        }
        self.resetKeys.append(sessionKey)
        await resetGate.wait()
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

    func patchSessionSettings(
        sessionKey _: String,
        agentID _: String?,
        patch _: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        await self.settingsPatchGate?.wait()
        throw NSError(domain: "SettingsTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Settings rejected"])
    }

    func waitForRunCompletion(runId _: String, timeoutMs _: Int) async -> OpenClawChatRunObservation {
        guard let completionGate else { return .unavailable }
        await completionGate.wait()
        return .terminal(.completed)
    }

    func release() async {
        await self.sendGate?.open()
        await self.historyGate?.open()
        await self.snapshotGate?.open()
        await self.validationGate?.open()
        await self.settingsPatchGate?.open()
        await self.resetGate?.open()
        await self.completionGate?.open()
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

    @Test(arguments: ["not_started", "may_have_executed", "unknown", "missing", "malformed"], [false, true])
    func `profile mismatch needs explicit non execution evidence and never replays`(
        execution: String, retire: Bool) async throws
    {
        var details = ["reason": AnyCodable("EXPECTED_PROFILE_MISMATCH")]
        if execution != "missing" {
            details["execution"] = execution == "malformed" ? AnyCodable(17) : AnyCodable(execution)
        }
        let error = GatewayResponseError(
            method: "chat.send", code: "INVALID_REQUEST", message: "Account changed", details: details)
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            responseError: error, retireOnResponseError: retire))
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
        let readback = await fixture.vm.submit(invocation, using: route)
        if retire {
            #expect(readback == .uncertain(
                reason: "Reconnect to the selected account to check this operation. Do not send it again."))
            #expect(fixture.vm.errorText == nil)
        } else {
            #expect(readback == outcome)
        }
        let released = !retire || execution == "not_started"
        #expect(await fixture.transport.sent.count == 1)
        #expect(fixture.vm.input == "preserved draft")
        #expect(fixture.vm.pendingRunCount == (released ? 0 : 1))
        #expect(fixture.vm.messages.count == (released ? 0 : 1))
        #expect(fixture.vm.canPreserveIdleTextDraft == released)
        await fixture.close()
    }

    @Test(arguments: ["UNAVAILABLE", "NEW_GATEWAY_ERROR"], [false, true])
    func `post-dispatch RPC errors retain uncertainty across duplicate waiters and replay`(
        code: String, claimsNotStarted: Bool) async throws
    {
        let gate = NativeSubmissionGate()
        let error = GatewayResponseError(
            method: "chat.send", code: code, message: "The Gateway response was unavailable.",
            details: claimsNotStarted ? ["execution": AnyCodable("not_started")] : [:])
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            sendGate: gate, responseError: error))
        await fixture.prepare()
        let vm = fixture.vm
        vm.input = "preserved composer draft"
        vm.setReplyTarget(messageID: UUID(), text: "preserved reply", senderLabel: "User")
        let reply = vm.replyTarget
        let attachment = OpenClawPendingAttachment(
            url: nil, data: Data([1, 2, 3]), fileName: "draft.png", mimeType: "image/png", preview: nil)
        vm.attachments = [attachment]
        let revision = vm.composerRevision(for: vm.sessionKey)
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let first = Task { await vm.submit(invocation, using: route) }
        var duplicate: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("native send entered before RPC error") { await gate.entered }
            let events = [
                "history:1:started", "history:1:returned", "send:\(invocation.operationID.uuidString)",
            ]
            #expect(await fixture.transport.wireEvents == events)
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(await fixture.transport.sent.count == 1)
            let validations = await fixture.transport.validationCalls
            let waiter = Task { await vm.submit(invocation, using: route) }
            duplicate = waiter
            try await waitUntil("duplicate joined the dispatched invocation") {
                await fixture.transport.validationCalls > validations
            }
            await gate.open()
            let expected = OpenClawChatSubmissionOutcome.uncertain(
                reason: "Delivery is unconfirmed. Check the selected chat before sending again.")
            #expect(await first.value == expected)
            #expect(await waiter.value == expected)
            #expect(await vm.submit(invocation, using: route) == expected)
            #expect(await fixture.transport.wireEvents == events)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(await fixture.transport.sent.count == 1)
            #expect(vm.input == "preserved composer draft")
            #expect(vm.replyTarget == reply)
            #expect(vm.attachments.map(\.id) == [attachment.id])
            #expect(vm.composerRevision(for: vm.sessionKey) == revision)
            #expect(vm.pendingRunCount == 0)
            #expect(vm.messages.isEmpty)
            #expect(vm.runMessageScopesByRunID[invocation.operationID.uuidString] == nil)
            #expect(!vm.isSending && !vm.isSubmittingDraft)
        } catch {
            await gate.open()
            _ = await first.value
            _ = await duplicate?.value
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test func `proven non dispatch releases only the detached attempt`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            sendGate: gate,
            responseError: GatewayResponseError(
                method: "chat.send", code: "INVALID_REQUEST", message: "Account changed",
                details: ["reason": AnyCodable("EXPECTED_PROFILE_MISMATCH"), "execution": AnyCodable("not_started")]),
            retireOnResponseError: true))
        await fixture.prepare()
        fixture.vm.input = "preserved draft"
        let snapshot = fixture.vm.currentSessionSnapshot()
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let task = Task { await fixture.vm.submit(invocation, using: route) }
        do {
            try await waitUntil("external send entered") { await gate.entered }
            #expect(fixture.vm.pendingRunCount == 1)
            fixture.vm.handleTransportEvent(.routeUnavailable(reason: "Retained account unavailable."))
            await gate.open()
            if case .notDispatched = await task.value {} else { Issue.record("Expected proven non-dispatch") }
            #expect(fixture.vm.currentSessionSnapshot() == snapshot)
            #expect(fixture.vm.pendingRunCount == 0)
            #expect(fixture.vm.messages.isEmpty)
            #expect(fixture.vm.runMessageScopesByRunID[invocation.operationID.uuidString] == nil)
            #expect(fixture.vm.input == "preserved draft")
            #expect(fixture.vm.errorText == "Retained account unavailable.")
            #expect(!fixture.vm.healthOK)
            #expect(fixture.vm.canPreserveIdleTextDraft)
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await fixture.close()
            _ = await task.value
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `final route refusal releases the reserved local attempt`(cancel: Bool) async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            validationGate: gate, validationGateCall: 3))
        await fixture.prepare()
        fixture.vm.input = "preserved draft"
        let route = await fixture.transport.route(fixture.target)
        let invocation = fixture.request()
        let task = Task { await fixture.vm.submit(invocation, using: route) }
        do {
            try await waitUntil("final route validation entered") { await gate.entered }
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(await fixture.transport.sent.isEmpty)
            #expect(fixture.vm.pendingRunCount == 1)
            await fixture.transport.invalidate()
            fixture.vm.errorText = "Retained presentation"
            if cancel { task.cancel() }
            await gate.open()
            let outcome = await task.value
            if cancel {
                #expect(outcome == .cancelled)
            } else if case .notDispatched = outcome {} else {
                Issue.record("Expected known pre-dispatch refusal")
            }
            #expect(await fixture.transport.sent.isEmpty)
            #expect(fixture.vm.pendingRunCount == 0)
            #expect(fixture.vm.messages.isEmpty)
            #expect(fixture.vm.input == "preserved draft")
            #expect(fixture.vm.errorText == "Retained presentation")
            #expect(fixture.vm.canPreserveIdleTextDraft)
        } catch {
            await fixture.close()
            _ = await task.value
            throw error
        }
        await fixture.close()
    }

    @Test func `old non dispatch cannot settle a successor session's operation`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            sendGate: gate,
            responseError: GatewayResponseError(
                method: "chat.send", code: "INVALID_REQUEST", message: "Account changed",
                details: ["reason": AnyCodable("EXPECTED_PROFILE_MISMATCH"), "execution": AnyCodable("not_started")]),
            retireOnResponseError: true))
        await fixture.prepare()
        let original = fixture.vm.currentSessionSnapshot()
        let route = await fixture.transport.route(fixture.target)
        let task = Task { await fixture.vm.submit(fixture.request(), using: route) }
        do {
            try await waitUntil("external send entered") { await gate.entered }
            fixture.vm.switchSession(to: "agent:agent-a:other", agentID: fixture.target.agentID)
            fixture.vm.switchSession(to: fixture.target.sessionKey, agentID: fixture.target.agentID)
            fixture.vm.detachTransport()
            #expect(fixture.vm.currentSessionSnapshot() != original)
            let successor = OpenClawChatMessage(
                role: "user", content: [], timestamp: 1, idempotencyKey: "successor:user")
            fixture.vm.replaceMessages([successor])
            fixture.vm.pendingRuns = ["successor"]
            fixture.vm.pendingLocalUserEchoMessageIDsByRunID["successor"] = successor.id
            fixture.vm.runMessageScopesByRunID["successor"] = fixture.vm.currentRunMessageScope()
            fixture.vm.input = "successor draft"
            fixture.vm.errorText = "successor status"
            await gate.open()
            if case .notDispatched = await task.value {} else { Issue.record("Expected proven non-dispatch") }
            #expect(fixture.vm.messages == [successor])
            #expect(fixture.vm.pendingRuns == ["successor"])
            #expect(fixture.vm.pendingLocalUserEchoMessageIDsByRunID == ["successor": successor.id])
            #expect(fixture.vm.runMessageScopesByRunID["successor"] != nil)
            #expect(fixture.vm.input == "successor draft")
            #expect(fixture.vm.errorText == "successor status")
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await fixture.close()
            _ = await task.value
            throw error
        }
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
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(sendGate: gate))
        await fixture.prepare()
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

    private func settingsHistory(_ target: OpenClawNativeSessionRef) -> [String: Any] {
        [
            "sessionKey": target.sessionKey, "sessionId": "session-a", "messages": [],
            "sessionInfo": [
                "key": target.sessionKey, "agentId": target.agentID, "sessionId": "session-a",
                "permissionMode": "guarded", "toolOverrides": ["webSearch": false],
            ],
        ]
    }

    @Test(arguments: ["capability", "stale"])
    func `external send requires current metadata and negotiated settings CAS`(failure: String) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            supportsSessionSettingsCAS: failure != "capability"))
        await fixture.prepare()
        if failure == "stale" { fixture.vm.invalidateSessionMetadataReadiness() }
        fixture.vm.input = "keep draft"
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(fixture.request(), using: route)
        if case .notDispatched = result {} else { Issue.record("Unverified capability must prevent dispatch") }
        #expect(await fixture.transport.sent.isEmpty)
        #expect(await fixture.transport.targetedHistoryRequests.isEmpty)
        #expect(await fixture.transport.catalogLoads == 0)
        #expect(fixture.vm.input == "keep draft")
        await fixture.close()
    }

    @Test(arguments: ["populated", "unset", "first-use", "new-incarnation"])
    func `exact history supplies settings outside the roster without pinning an old incarnation`(
        state: String) async throws
    {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(), sessionKey: "global")
        do {
            var other = fixture.vm.sessions[0]
            other.agentId = "agent-b"
            other.permissionMode = .full
            other.toolOverrides = nil
            fixture.vm.sessions = [other]
            fixture.vm.sessionId = "previous-incarnation"
            var history = self.settingsHistory(fixture.target)
            var row = try #require(history["sessionInfo"] as? [String: Any])
            let unset = state == "unset" || state == "first-use"
            if unset {
                row.removeValue(forKey: "permissionMode")
                row["toolOverrides"] = NSNull()
            }
            if state == "first-use" {
                history["sessionId"] = NSNull()
                row.removeValue(forKey: "sessionId")
            } else if state == "new-incarnation" {
                history["sessionId"] = "replacement-incarnation"
                row["sessionId"] = "replacement-incarnation"
            }
            history["sessionInfo"] = row
            history["toolOverrides"] = ["webSearch": true]
            try await fixture.transport.setSnapshotData(JSONSerialization.data(withJSONObject: history))
            let request = fixture.request()
            let route = await fixture.transport.route(fixture.target)
            #expect(await fixture.vm.submit(request, using: route) ==
                .accepted(runID: "remote-\(request.operationID.uuidString)"))
            let sent = await fixture.transport.sent
            #expect(sent.count == 1)
            #expect(sent.first?.key == "global")
            #expect(sent.first?.agent == fixture.target.agentID)
            #expect(sent.first?.settings == OpenClawChatSessionSettingsExpectation(
                permissionMode: unset ? nil : .guarded,
                toolOverrides: unset ? nil : .init(webSearch: false)))
            #expect(!fixture.vm.sessions.contains { $0.agentId == fixture.target.agentID })
            #expect(await fixture.transport.wireEvents.prefix(3) == [
                "history:1:started", "history:1:returned", "send:\(request.operationID.uuidString)",
            ])
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [
        "missing row", "missing key", "wrong key", "missing agent", "wrong agent", "header key",
        "header id", "missing header id", "row id", "row id type", "empty id",
        "permission type", "unknown permission", "tools type", "unavailable",
    ])
    func `unverified exact history refuses before dispatch and releases only its attempt`(failure: String) async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        do {
            var history = self.settingsHistory(fixture.target)
            var row = try #require(history["sessionInfo"] as? [String: Any])
            switch failure {
            case "missing key": row.removeValue(forKey: "key")
            case "wrong key": row["key"] = "agent:agent-a:other"
            case "missing agent": row.removeValue(forKey: "agentId")
            case "wrong agent": row["agentId"] = "agent-b"
            case "header key": history["sessionKey"] = "other"
            case "header id": history["sessionId"] = "different"
            case "missing header id": history.removeValue(forKey: "sessionId")
            case "row id type": row["sessionId"] = 17
            case "row id": row.removeValue(forKey: "sessionId")
            case "empty id":
                history["sessionId"] = ""
                row["sessionId"] = ""
            case "permission type": row["permissionMode"] = 17
            case "unknown permission": row["permissionMode"] = "unknown"
            case "tools type": row["toolOverrides"] = ["webSearch": "false"]
            default: break
            }
            if failure == "missing row" { history["sessionInfo"] = NSNull() } else { history["sessionInfo"] = row }
            try await fixture.transport.setSnapshotData(JSONSerialization.data(withJSONObject: history))
            if failure == "unavailable" { await fixture.transport.setSnapshotUnavailable() }
            fixture.vm.input = "keep draft"
            fixture.vm.setReplyTarget(messageID: UUID(), text: "keep reply", senderLabel: "User")
            let reply = fixture.vm.replyTarget
            let request = fixture.request()
            let route = await fixture.transport.route(fixture.target)
            let result = await fixture.vm.submit(request, using: route)
            #expect(result == .notDispatched(
                reason: "Could not verify this session's permissions. Refresh the chat and try again."))
            #expect(await fixture.transport.sent.isEmpty)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(fixture.vm.pendingRunCount == 0)
            #expect(fixture.vm.messages.isEmpty)
            #expect(fixture.vm.runMessageScopesByRunID[request.operationID.uuidString] == nil)
            #expect(fixture.vm.input == "keep draft")
            #expect(fixture.vm.replyTarget == reply)
            #expect(!fixture.vm.isSending && !fixture.vm.isSubmittingDraft)
            #expect(await fixture.vm.submit(request, using: route) == result)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `canonically equivalent history owner spelling cannot supply settings`(changeAgent: Bool) async throws {
        let fixture = try NativeSubmissionFixture(
            transport: NativeSubmissionTransport(), sessionKey: "global-\u{e9}", agentID: "agent-\u{e9}")
        do {
            var history = self.settingsHistory(fixture.target)
            var row = try #require(history["sessionInfo"] as? [String: Any])
            row[changeAgent ? "agentId" : "key"] = changeAgent ? "agent-e\u{301}" : "global-e\u{301}"
            history["sessionInfo"] = row
            try await fixture.transport.setSnapshotData(JSONSerialization.data(withJSONObject: history))
            let route = await fixture.transport.route(fixture.target)
            let result = await fixture.vm.submit(fixture.request(), using: route)
            if case .notDispatched = result {} else { Issue.record("History ownership requires exact UTF8") }
            #expect(await fixture.transport.sent.isEmpty)
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .rejected, .uncertain])
    func `same invocation joins and retains its original execution`(response: NativeSubmissionTransport
        .Response) async throws
    {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response,
            sendGate: gate))
        await fixture.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let replacement = NativeSubmissionTransport()
        let replacementRoute = await replacement.route(fixture.target)
        let first = Task { await fixture.vm.submit(request, using: route) }
        var duplicate: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("native send entered") { await gate.entered }
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
        await fixture.transport.setTargetedHistoryReplies([.snapshot, .reconciliation])
        await fixture.prepare()
        let request = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let result = await fixture.vm.submit(request, using: route)
        #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
        #expect(fixture.vm.pendingRunCount == 1)
        #expect(!fixture.vm.isSending)
        do {
            try await waitUntil("post-dispatch history entered") { await gate.entered }
            #expect(await fixture.transport.wireEvents == [
                "history:1:started", "history:1:returned", "send:\(request.operationID.uuidString)",
                "history:2:started",
            ])
            #expect(await fixture.transport.targetedHistoryReturns == [1])
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: ["committed", "empty-history", "empty-run"])
    func `aborted timeout receipt retains its operation but history owns the user turn`(
        scenario: String) async throws
    {
        let emptyRunID = scenario == "empty-run"
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: "timeout", ackRunID: emptyRunID ? "" : "admitted-run", ackSummary: "aborted"))
        await fixture.transport.setTargetedHistoryReplies([.snapshot, .reconciliation])
        await fixture.prepare()
        let messages = scenario == "committed"
            ? #"[{"role":"user","content":[{"type":"text","text":"external text"}],"idempotencyKey":"admitted-run:user"}]"#
            : "[]"
        try await fixture.transport.setHistoryPayload(JSONDecoder().decode(
            OpenClawChatHistoryPayload.self,
            from: Data("""
            {"sessionKey":"\(fixture.target.sessionKey)","sessionId":"session-a","messages":\(messages),
             "sessionInfo":{"key":"\(fixture.target.sessionKey)","agentId":"\(fixture.target.agentID)",
                            "sessionId":"session-a","permissionMode":"guarded","toolOverrides":{"webSearch":false}}}
            """.utf8)))
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
        await fixture.close()
    }

    @Test(arguments: [false, true])
    func `visible ACK keeps the surviving canonical user scope before history`(reusedScope: Bool) async throws {
        let historyGate = NativeSubmissionGate()
        let runID = "canonical-run"
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: "started", ackRunID: runID))
        await fixture.prepare()
        let vm = fixture.vm
        if reusedScope {
            let canonical = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data("""
            {"role":"user","content":[{"type":"text","text":"canonical request"}],
             "timestamp":1,"idempotencyKey":"canonical-run:user"}
            """.utf8))
            vm.messages = [canonical]
            vm.runMessageScopesByRunID[runID] = vm.currentRunMessageScope()
            let newer = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data("""
            {"role":"user","content":[{"type":"text","text":"newer request"}],
             "timestamp":2,"idempotencyKey":"newer-run:user"}
            """.utf8))
            vm.messages.append(newer)
        }
        let payload = OpenClawChatHistoryPayload(
            sessionKey: fixture.target.sessionKey, sessionId: "session-a", messages: [], thinkingLevel: nil)
        await fixture.transport.setTargetedHistoryReplies([.snapshot, .held(payload, historyGate)])
        let invocation = fixture.request()
        let route = await fixture.transport.route(fixture.target)
        let submitting = Task { await vm.submit(invocation, using: route) }
        var ownedTasks: [Task<Void, Never>] = []
        func closeOwnedWork() async {
            ownedTasks += Array(vm.pendingRunOwnerTasks.values)
            vm.detachTransport()
            await historyGate.open()
            await fixture.transport.release()
            _ = await submitting.value
            for task in ownedTasks {
                await task.value
            }
            await fixture.close()
        }
        do {
            // Hold the actual post-ACK read so history cannot repair a bad scope.
            try await waitUntil("canonical scope held before post-ACK history") { await historyGate.entered }
            #expect(await submitting.value == .accepted(runID: runID))
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            let surviving = vm.messages.filter { $0.idempotencyKey == "\(runID):user" }
            try #require(surviving.count == 1)
            let scope = try #require(vm.runMessageScopesByRunID[runID])
            #expect(scope.session == vm.currentSessionSnapshot())
            #expect(scope.latestUserTurn?.idempotencyKey == "\(runID):user")
            #expect(scope.latestUserTurn?.timestamp == surviving[0].timestamp)
            #expect(!vm.messages.contains { $0.idempotencyKey == "\(invocation.operationID.uuidString):user" })
            if reusedScope {
                #expect(scope.latestUserTurn?.timestamp == 1)
                #expect(vm.messages.contains { $0.idempotencyKey == "newer-run:user" })
            }
            #expect(vm.pendingRuns == [runID])
            #expect(vm.pendingRunOwnerTasks[runID] != nil)
        } catch {
            await closeOwnedWork()
            throw error
        }
        await closeOwnedWork()
    }

    @Test(arguments: ["ok", "aborted", "started", "in_flight"])
    func `retired presentation keeps accepted run ownership without projecting effects`(status: String) async throws {
        let sendGate = NativeSubmissionGate()
        let completionGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: status == "aborted" ? "timeout" : status, ackRunID: "accepted-run",
            ackSummary: status == "aborted" ? "aborted" : nil,
            sendGate: sendGate, completionGate: completionGate))
        await fixture.prepare()
        let presentation = NativeSubmissionPresentation()
        let physical = await fixture.transport.route(fixture.target)
        let route = OpenClawChatExternalSubmissionRoute(
            target: fixture.target, lease: physical.lease, accountIsCurrent: physical.accountIsCurrent,
            presentationIsCurrent: { presentation.isCurrent })
        let invocation = fixture.request()
        let vm = fixture.vm
        let submitting = Task { await vm.submit(invocation, using: route) }
        var ownedTasks: [Task<Void, Never>] = []
        func closeOwnedWork() async {
            ownedTasks += Array(vm.pendingRunOwnerTasks.values)
            vm.detachTransport()
            await fixture.transport.release()
            _ = await submitting.value
            for task in ownedTasks {
                await task.value
            }
            await fixture.close()
        }
        do {
            try await waitUntil("send held before ACK") { await sendGate.entered }
            presentation.isCurrent = false
            vm.input = "retained draft"
            vm.errorText = "retained error"
            let messages = vm.messages
            let stream = vm.streamingAssistantText
            let tools = vm.turnToolCallsById
            await sendGate.open()
            #expect(await submitting.value == .accepted(runID: "accepted-run"))
            #expect(!vm.pendingRuns.contains(invocation.operationID.uuidString))
            #expect(vm.messages == messages)
            #expect(vm.input == "retained draft")
            #expect(vm.errorText == "retained error")
            #expect(vm.streamingAssistantText == stream)
            #expect(vm.turnToolCallsById == tools)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            if status == "started" || status == "in_flight" {
                #expect(vm.pendingRuns == ["accepted-run"])
                #expect(vm.runMessageScopesByRunID["accepted-run"]?.session == vm.currentSessionSnapshot())
                let owner = try #require(vm.pendingRunOwnerTasks["accepted-run"])
                ownedTasks.append(owner)
                try await waitUntil("captured run completion wait entered") { await completionGate.entered }
                await completionGate.open()
                try await waitUntil("terminal observation released hidden run") {
                    await MainActor.run { vm.pendingRunCount == 0 }
                }
                await owner.value
            }
            #expect(vm.pendingRuns.isEmpty)
            #expect(vm.pendingRunOwnerTasks["accepted-run"] == nil)
            #expect(vm.liveRunStateByRunID["accepted-run"]?.terminal == true)
            #expect(vm.messages == messages)
            #expect(vm.input == "retained draft")
            #expect(vm.errorText == "retained error")
            #expect(vm.streamingAssistantText == stream)
            #expect(vm.turnToolCallsById == tools)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            if case .uncertain = await vm.submit(invocation, using: route) {} else {
                Issue.record("Retired presentation cannot read the original accepted receipt")
            }
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await closeOwnedWork()
            throw error
        }
        await closeOwnedWork()
    }

    @Test func `presentation retirement during terminal ACK history still releases its run`() async throws {
        let historyGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(ackStatus: "ok"))
        await fixture.prepare()
        let presentation = NativeSubmissionPresentation()
        let physical = await fixture.transport.route(fixture.target)
        let route = OpenClawChatExternalSubmissionRoute(
            target: fixture.target, lease: physical.lease, accountIsCurrent: physical.accountIsCurrent,
            presentationIsCurrent: { presentation.isCurrent })
        let payload = OpenClawChatHistoryPayload(
            sessionKey: fixture.target.sessionKey, sessionId: "session-a", messages: [], thinkingLevel: nil)
        await fixture.transport.setTargetedHistoryReplies([.snapshot, .held(payload, historyGate)])
        let invocation = fixture.request()
        let vm = fixture.vm
        let submitting = Task { await vm.submit(invocation, using: route) }
        var ownedTasks: [Task<Void, Never>] = []
        func closeOwnedWork() async {
            ownedTasks += Array(vm.pendingRunOwnerTasks.values)
            vm.detachTransport()
            await historyGate.open()
            await fixture.transport.release()
            _ = await submitting.value
            for task in ownedTasks {
                await task.value
            }
            await fixture.close()
        }
        do {
            try await waitUntil("post-ACK history held") { await historyGate.entered }
            let runID = "remote-\(invocation.operationID.uuidString)"
            #expect(await submitting.value == .accepted(runID: runID))
            ownedTasks += Array(vm.pendingRunOwnerTasks.values)
            presentation.isCurrent = false
            vm.errorText = "retained error"
            let messages = vm.messages
            await historyGate.open()
            try await waitUntil("retired terminal ACK settled") { await MainActor.run { vm.pendingRuns.isEmpty } }
            #expect(vm.messages == messages)
            #expect(vm.errorText == "retained error")
            #expect(vm.liveRunStateByRunID[runID]?.terminal == true)
            #expect(await fixture.transport.targetedHistoryRequests.count == 2)
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await closeOwnedWork()
            throw error
        }
        await closeOwnedWork()
    }

    @Test(arguments: ["aborted", "ok"], [false, true])
    func `terminal receipt retires only its selected run after history reconciliation`(
        outcome: String, successor: Bool) async throws
    {
        let historyGate = NativeSubmissionGate()
        let routeGate = NativeSubmissionGate()
        let ackRunID = "receipt-run"
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            ackStatus: outcome == "aborted" ? "timeout" : "ok", ackRunID: ackRunID,
            ackSummary: outcome == "aborted" ? "aborted" : nil))
        await fixture.prepare()
        let vm = fixture.vm
        let runID = successor ? "successor-run" : ackRunID
        let payload = OpenClawChatHistoryPayload(
            sessionKey: fixture.target.sessionKey, sessionId: "session-a", messages: [], thinkingLevel: nil,
            sessionInfo: OpenClawChatSessionInfo(
                hasActiveRun: successor, activeRunIds: successor ? [runID] : [], key: fixture.target.sessionKey,
                agentId: fixture.target.agentID, sessionId: "session-a"),
            inFlightRun: successor ? OpenClawChatInFlightRun(runId: runID, text: "successor run text") : nil)
        // Hold the captured post-ACK read before it installs this run snapshot.
        await fixture.transport.setTargetedHistoryReplies([.snapshot, .held(payload, historyGate)])
        vm.input = "preserved composer draft"
        let session = vm.currentSessionSnapshot()
        // Run snapshots apply even while an unanswered user keeps older transcript replies admissible.
        let initialRunSnapshotRequest = vm.latestAppliedRunSnapshotRequestID
        let invocation = fixture.request()
        let physical = await fixture.transport.route(fixture.target)
        let route = OpenClawChatExternalSubmissionRoute(
            target: fixture.target, lease: physical.lease,
            accountIsCurrent: {
                let current = await physical.accountIsCurrent()
                if await MainActor.run(body: { vm.latestAppliedRunSnapshotRequestID > initialRunSnapshotRequest }) {
                    await routeGate.wait()
                }
                return current
            },
            presentationIsCurrent: { true })
        let submitting = Task { await vm.submit(invocation, using: route) }
        var ownedRuns: [Task<Void, Never>] = []
        func closeOwnedWork() async {
            let currentOwners = Array(vm.pendingRunOwnerTasks.values)
            vm.detachTransport()
            await historyGate.open()
            await routeGate.open()
            await fixture.transport.release()
            _ = await submitting.value
            for owner in ownedRuns + currentOwners {
                await owner.value
            }
            await fixture.close()
        }
        do {
            try await waitUntil("terminal receipt history suspended") { await historyGate.entered }
            #expect(await submitting.value == .accepted(runID: ackRunID))
            #expect(await fixture.transport.wireEvents == [
                "history:1:started", "history:1:returned", "send:\(invocation.operationID.uuidString)",
                "history:2:started",
            ])
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(vm.pendingRuns == [ackRunID])
            #expect(vm.liveUsageRunID == ackRunID)
            try ownedRuns.append(#require(vm.pendingRunOwnerTasks[ackRunID]))
            await historyGate.open()

            try await waitUntil("reconciled run installed before terminal admission") { await routeGate.entered }
            #expect(vm.latestAppliedRunSnapshotRequestID > initialRunSnapshotRequest)
            #expect(await fixture.transport.targetedHistoryReturns == [1, 2])
            #expect(vm.currentSessionSnapshot() == session)
            #expect(vm.pendingRuns == [runID])
            #expect(vm.liveUsageRunID == runID)
            try #require(vm.liveRunStateByRunID[ackRunID]?.terminal != true)
            if successor {
                #expect(vm.streamingAssistantText == "successor run text")
            } else {
                let assistant = try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: Data("""
                {"runId":"\(ackRunID)","seq":1,"stream":"assistant","data":{"text":"receipt run text"}}
                """.utf8))
                vm.handleTransportEvent(.agent(assistant))
                #expect(vm.streamingAssistantText == "receipt run text")
            }
            let selectedOwner = try #require(vm.pendingRunOwnerTasks[runID])
            let selectedArm = try #require(vm.pendingRunOwnerArmIDs[runID])
            ownedRuns.append(selectedOwner)
            let tool = try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: Data("""
            {"runId":"\(runID)","seq":2,"stream":"tool","ts":1,
             "data":{"phase":"start","name":"read","toolCallId":"selected-tool","args":{"path":"README.md"}}}
            """.utf8))
            vm.handleTransportEvent(.agent(tool))
            let selectedTools = vm.turnToolCallsById
            #expect(selectedTools["selected-tool"]?.name == "read")
            #expect(!selectedOwner.isCancelled)
            await routeGate.open()

            try await waitUntil("terminal receipt retired") {
                await MainActor.run { vm.liveRunStateByRunID[ackRunID]?.terminal == true }
            }
            #expect(vm.pendingLocalUserEchoMessageIDsByRunID[ackRunID] == nil)
            #expect(vm.pendingRunOwnerTasks[ackRunID] == nil)
            #expect(vm.pendingRunOwnerArmIDs[ackRunID] == nil)
            #expect(!vm.pendingRuns.contains(ackRunID))
            if successor {
                #expect(vm.pendingRuns == [runID])
                #expect(vm.liveUsageRunID == runID)
                #expect(vm.streamingAssistantText == "successor run text")
                #expect(vm.turnToolCallsById == selectedTools)
                #expect(vm.pendingRunOwnerArmIDs[runID] == selectedArm)
                #expect(vm.pendingRunOwnerTasks[runID] != nil)
                #expect(!selectedOwner.isCancelled)
                #expect(vm.runMessageScopesByRunID[runID]?.session == session)
            } else {
                #expect(vm.pendingRunCount == 0)
                #expect(vm.liveUsageRunID == nil)
                #expect(vm.streamingAssistantText == nil)
                #expect(vm.turnToolCallsById.isEmpty)
                #expect(selectedOwner.isCancelled)
            }
            #expect(vm.input == "preserved composer draft")
            #expect(vm.errorText == nil)
            let wire = await fixture.transport.wireEvents
            #expect(await vm.submit(invocation, using: route) == .accepted(runID: ackRunID))
            #expect(await fixture.transport.wireEvents == wire)
            #expect(await fixture.transport.targetedHistoryRequests.count == 2)
            #expect(await fixture.transport.sent.count == 1)
            #expect(vm.pendingRuns == (successor ? [runID] : []))
            #expect(vm.streamingAssistantText == (successor ? "successor run text" : nil))
            #expect(vm.turnToolCallsById == (successor ? selectedTools : [:]))
        } catch {
            await closeOwnedWork()
            throw error
        }
        await closeOwnedWork()
    }

    @Test(arguments: [false, true])
    func `retired native reconciliation cannot change the retained presentation`(duringHistory: Bool) async throws {
        let gate = NativeSubmissionGate()
        let transport = NativeSubmissionTransport(
            ackStatus: "ok",
            historyGate: duringHistory ? gate : nil,
            validationGate: duringHistory ? nil : gate,
            validationGateCall: 5)
        let fixture = try NativeSubmissionFixture(transport: transport)
        await transport.setTargetedHistoryReplies([.snapshot, .reconciliation])
        await fixture.prepare()
        try await transport.setHistoryPayload(JSONDecoder().decode(
            OpenClawChatHistoryPayload.self,
            from: Data("""
            {"sessionKey":"\(fixture.target.sessionKey)","sessionId":"session-a","messages":[
              {"role":"assistant","content":[{"type":"text","text":"stale history"}],"timestamp":1}
            ],"sessionInfo":{"key":"\(fixture.target.sessionKey)","agentId":"\(fixture.target.agentID)",
                             "sessionId":"session-a","permissionMode":"guarded","toolOverrides":{"webSearch":false}}}
            """.utf8)))
        let invocation = fixture.request()
        let route = await transport.route(fixture.target)
        #expect(await fixture.vm.submit(invocation, using: route) ==
            .accepted(runID: "remote-\(invocation.operationID.uuidString)"))
        do {
            try await waitUntil("reconciliation suspended") { await gate.entered }
            #expect(await transport.wireEvents.prefix(3) == [
                "history:1:started", "history:1:returned", "send:\(invocation.operationID.uuidString)",
            ])
            #expect(await transport.targetedHistoryRequests.count == (duringHistory ? 2 : 1))
            #expect(await transport.targetedHistoryReturns == [1])
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

    @Test(arguments: [false, true])
    func `failed settings settle only the retired presentation's unsent attempt`(successorSession: Bool) async throws {
        let patchGate = NativeSubmissionGate()
        let historyGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            historyGate: historyGate, settingsPatchGate: patchGate, supportsComposerCapabilities: true))
        await fixture.prepare()
        let target = fixture.vm.currentModelPatchTarget()
        fixture.vm.selectComposerPermissionMode(.readOnly)
        let presentation = NativeSubmissionPresentation()
        let physicalRoute = await fixture.transport.route(fixture.target)
        let route = OpenClawChatExternalSubmissionRoute(
            target: fixture.target, lease: physicalRoute.lease,
            accountIsCurrent: physicalRoute.accountIsCurrent,
            presentationIsCurrent: { presentation.isCurrent })
        var submissionTask: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("actual settings patch entered") { await patchGate.entered }
            let snapshot = fixture.vm.currentSessionSnapshot()
            let invocation = fixture.request()
            let runID = invocation.operationID.uuidString
            let task = Task { await fixture.vm.submit(invocation, using: route) }
            submissionTask = task
            try await waitUntil("external attempt reserved behind settings") {
                await MainActor.run {
                    fixture.vm.pendingLocalUserEchoMessageIDsByRunID[runID] != nil &&
                        fixture.vm.inFlightSettingsPatchCountsByTarget[target] == 1
                }
            }
            let echoID = try #require(fixture.vm.pendingLocalUserEchoMessageIDsByRunID[runID])
            #expect(await fixture.transport.sent.isEmpty)
            presentation.isCurrent = false
            if successorSession {
                fixture.vm.switchSession(to: "agent:agent-a:other", agentID: fixture.target.agentID)
                fixture.vm.switchSession(to: fixture.target.sessionKey, agentID: fixture.target.agentID)
                #expect(fixture.vm.currentSessionSnapshot() != snapshot)
            } else {
                #expect(fixture.vm.currentSessionSnapshot() == snapshot)
            }
            let unrelated = OpenClawChatMessage(
                role: "user", content: [], timestamp: 1, idempotencyKey: "other-run:user")
            fixture.vm.appendMessage(unrelated)
            fixture.vm.pendingRuns.insert("other-run")
            fixture.vm.pendingLocalUserEchoMessageIDsByRunID["other-run"] = unrelated.id
            fixture.vm.runMessageScopesByRunID["other-run"] = fixture.vm.currentRunMessageScope()
            fixture.vm.input = "edited current draft"
            fixture.vm.setReplyTarget(messageID: UUID(), text: "current reply", senderLabel: "User")
            let reply = fixture.vm.replyTarget
            let attachment = OpenClawPendingAttachment(
                url: nil, data: Data([1]), fileName: "draft.png", mimeType: "image/png", preview: nil)
            fixture.vm.attachments = [attachment]
            #expect(await physicalRoute.isCurrent())
            await patchGate.open()
            #expect(await task.value == .notDispatched(reason: "Settings rejected"))
            #expect(await fixture.transport.sent.isEmpty)
            #expect(!fixture.vm.pendingRuns.contains(runID))
            #expect(fixture.vm.pendingLocalUserEchoMessageIDsByRunID[runID] == nil)
            #expect(fixture.vm.runMessageScopesByRunID[runID] == nil)
            #expect(!fixture.vm.messages.contains { $0.id == echoID })
            #expect(fixture.vm.pendingRuns == ["other-run"])
            #expect(fixture.vm.pendingLocalUserEchoMessageIDsByRunID == ["other-run": unrelated.id])
            #expect(fixture.vm.runMessageScopesByRunID["other-run"] != nil)
            #expect(fixture.vm.messages.contains { $0.id == unrelated.id })
            #expect(fixture.vm.input == "edited current draft")
            #expect(fixture.vm.replyTarget == reply)
            #expect(fixture.vm.attachments.map(\.id) == [attachment.id])
            #expect(!fixture.vm.isSending && !fixture.vm.isSubmittingDraft)
            #expect(await fixture.vm.submit(invocation, using: route) == .uncertain(
                reason: "Reconnect to the selected account to check this operation. Do not send it again."))
            #expect(await fixture.transport.sent.isEmpty)
        } catch {
            await fixture.transport.release()
            _ = await submissionTask?.value
            await fixture.vm.waitForPendingSessionSettings(for: target)
            await fixture.close()
            throw error
        }
        await fixture.transport.release()
        _ = await submissionTask?.value
        await fixture.vm.waitForPendingSessionSettings(for: target)
        await fixture.close()
    }

    @Test(arguments: ["accepted", "failed patch", "changed lease", "stale metadata", "wrong agent"])
    func `external send waits for settings and revalidates the owner`(completion: String) async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let target = fixture.vm.currentModelPatchTarget()
        var history = self.settingsHistory(fixture.target)
        history["sessionInfo"] = [
            "key": fixture.target.sessionKey,
            "agentId": completion == "wrong agent" ? "agent-b" : fixture.target.agentID,
            "sessionId": "session-a", "permissionMode": "full", "toolOverrides": NSNull(),
        ]
        let updatedHistory: Data
        do {
            updatedHistory = try JSONSerialization.data(withJSONObject: history)
        } catch {
            await fixture.close()
            throw error
        }
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
                await fixture.transport.setSnapshotData(updatedHistory)
            }
        }
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("submission waits for settings") { await MainActor.run { fixture.vm.isSending } }
            #expect(await fixture.transport.sent.isEmpty)
            #expect(await fixture.transport.targetedHistoryRequests.isEmpty)
            switch completion {
            case "changed lease": await fixture.transport.invalidate()
            case "stale metadata": fixture.vm.invalidateSessionMetadataReadiness()
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
                #expect(result == .notDispatched(reason: "Settings rejected"))
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

    @Test
    func `initial owner verification failure leaves the same invocation unstarted`() async throws {
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport())
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let failure = NSError(domain: "NativeSubmissionVerification", code: 1)
        do {
            do {
                _ = try await fixture.vm.submit(request, using: route, ownerVerification: .failure(failure))
                Issue.record("Initial verification must preserve its admission error")
            } catch {
                #expect(error as NSError === failure)
            }
            #expect(await fixture.transport.sent.isEmpty)
            #expect(try await fixture.vm.submit(request, using: route, ownerVerification: .success(())) ==
                .accepted(runID: "remote-\(request.operationID.uuidString)"))
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await fixture.close()
            throw error
        }
        await fixture.close()
    }

    @Test(arguments: [NativeSubmissionTransport.Response.accepted, .uncertain])
    func `failed owner verification observes a concurrently started invocation without retiring it`(
        response: NativeSubmissionTransport.Response) async throws
    {
        let verificationGate = NativeSubmissionGate()
        let sendGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: response, sendGate: sendGate))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let verification = Task {
            await verificationGate.wait()
            return try await fixture.vm.submit(
                request, using: route,
                ownerVerification: .failure(NSError(domain: "NativeSubmissionVerification", code: 1)))
        }
        var original: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("owner verification started before submission") { await verificationGate.entered }
            let sending = Task { await fixture.vm.submit(request, using: route) }
            original = sending
            try await waitUntil("original send entered") { await sendGate.entered }
            await verificationGate.open()
            #expect(try await verification.value == .uncertain(
                reason: "Reconnect to the selected account to check this operation. Do not send it again."))
            #expect(!sending.isCancelled)
            #expect(fixture.vm.isSending)
            #expect(await fixture.transport.sent.count == 1)
            await sendGate.open()
            let result = await sending.value
            if case .accepted = response {
                #expect(result == .accepted(runID: "remote-\(request.operationID.uuidString)"))
            } else {
                #expect(result == .uncertain(
                    reason: "Delivery is unconfirmed. Check the selected chat before sending again."))
            }
            // This transient verifier failure leaves the original, still-current
            // route intact. A retired socket/account must never recover this readback.
            #expect(try await fixture.vm.submit(request, using: route, ownerVerification: .success(())) == result)
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            verification.cancel()
            original?.cancel()
            await verificationGate.open()
            await sendGate.open()
            _ = try? await verification.value
            _ = await original?.value
            await fixture.close()
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
            validationGateCall: 3))
        await fixture.prepare()
        let route = await fixture.transport.route(fixture.target)
        let request = fixture.request()
        let task = Task { await fixture.vm.submit(request, using: route) }
        do {
            try await waitUntil("final route validation entered") { await validation.entered }
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(await fixture.transport.sent.isEmpty)
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

    @Test(arguments: ["before-confirmation", "history", "final-route"])
    func `native send waits for a real reset across every admission boundary without replay`(
        phase: String) async throws
    {
        let resetGate = NativeSubmissionGate()
        let admissionGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            snapshotGate: phase == "history" ? admissionGate : nil,
            validationGate: phase == "final-route" ? admissionGate : nil,
            resetGate: resetGate,
            validationGateCall: 3))
        await fixture.prepare()
        let vm = fixture.vm
        await fixture.transport.setHistoryPayload(OpenClawChatHistoryPayload(
            sessionKey: fixture.target.sessionKey, sessionId: "session-a", messages: [], thinkingLevel: nil,
            sessionInfo: OpenClawChatSessionInfo(
                hasActiveRun: false, key: fixture.target.sessionKey, agentId: fixture.target.agentID,
                sessionId: "session-a", permissionMode: .guarded, toolOverrides: .init(webSearch: false))))
        await fixture.transport.setSessionsPayload(OpenClawChatSessionsListResponse(
            ts: nil, path: nil, count: vm.sessions.count, defaults: nil, sessions: vm.sessions))
        let route = await fixture.transport.route(fixture.target)
        let invocation = fixture.request()
        let session = vm.currentSessionSnapshot()
        let target = vm.currentSessionTarget
        let metadataGeneration = vm.sessionMetadataGeneration
        let branchGeneration = vm.nextSessionBranchSwitchGeneration
        vm.input = "preserved reset draft"
        var submitting: Task<OpenClawChatSubmissionOutcome, Never>?
        var resetting: Task<Void, Never>?
        do {
            if phase != "before-confirmation" {
                submitting = Task { await vm.submit(invocation, using: route) }
                try await waitUntil("native admission suspended before reset") { await admissionGate.entered }
                #expect(await fixture.transport.targetedHistoryRequests.count == 1)
                #expect(await fixture.transport.targetedHistoryReturns == (phase == "history" ? [] : [1]))
                #expect(vm.pendingRunCount == 1)
            }
            resetting = Task { await vm.performReset(presentationIsCurrent: { true }) }
            try await waitUntil("reset RPC entered") { await resetGate.entered }
            #expect(await fixture.transport.resetKeys == [fixture.target.sessionKey])
            #expect(vm.isLoading)
            #expect(vm.isCurrentSession(session))
            #expect(vm.currentSessionTarget == target)
            #expect(vm.nextSessionBranchSwitchGeneration == branchGeneration)
            #expect(vm.sessionMetadataGeneration == metadataGeneration)
            #expect(vm.hasCurrentSessionMetadata)
            #expect(vm.healthOK)
            #expect(await fixture.transport.sent.isEmpty)
            if phase == "before-confirmation" {
                submitting = Task { await vm.submit(invocation, using: route) }
            }
            await admissionGate.open()
            let submission = try #require(submitting)
            let result = await submission.value
            #expect(result == .notDispatched(
                reason: "Wait for this chat to finish loading, then try this action again."))
            // Keep reset suspended: route, metadata and target still authorize the
            // same session, so only the loading owner can explain this refusal.
            #expect(await route.isCurrent())
            #expect(vm.isLoading && vm.hasCurrentSessionMetadata)
            #expect(vm.isCurrentSession(session))
            #expect(vm.sessionMetadataGeneration == metadataGeneration)
            #expect(await fixture.transport.sent.isEmpty)
            #expect(vm.pendingRunCount == 0)
            #expect(vm.pendingLocalUserEchoMessageIDsByRunID[invocation.operationID.uuidString] == nil)
            #expect(vm.runMessageScopesByRunID[invocation.operationID.uuidString] == nil)
            #expect(vm.messages.isEmpty)
            #expect(vm.input == "preserved reset draft")
            #expect(!vm.isSending && !vm.isSubmittingDraft)
            let admissionReads = phase == "before-confirmation" ? 0 : 1
            #expect(await fixture.transport.targetedHistoryRequests.count == admissionReads)
            #expect(await vm.submit(invocation, using: route) == result)
            #expect(await fixture.transport.targetedHistoryRequests.count == admissionReads)
            #expect(await fixture.transport.sent.isEmpty)

            await resetGate.open()
            await resetting?.value
            try await waitUntil("successful reset bootstrap restored readiness") {
                await MainActor.run { !vm.isLoading && vm.hasCurrentSessionMetadata && vm.healthOK }
            }
            #expect(await fixture.transport.historyReturns == 1)
            #expect(await fixture.transport.sessionListCalls == 1)
            #expect(vm.hasAppliedLiveHistory)
            #expect(vm.currentSessionTarget == target)
            #expect(vm.input == "preserved reset draft")
            #expect(await vm.submit(invocation, using: route) == result)
            #expect(await fixture.transport.targetedHistoryRequests.count == admissionReads)
            #expect(await fixture.transport.sent.isEmpty)

            let fresh = fixture.request("fresh intentional send")
            #expect(fresh.operationID != invocation.operationID)
            submitting = Task { await vm.submit(fresh, using: route) }
            let freshSubmission = try #require(submitting)
            #expect(await freshSubmission.value == .accepted(runID: "remote-\(fresh.operationID.uuidString)"))
            let sent = await fixture.transport.sent
            #expect(sent.count == 1)
            #expect(sent.first?.id == fresh.operationID.uuidString)
            #expect(sent.first?.text == "fresh intentional send")
            let wire = await fixture.transport.wireEvents
            let read = try #require(wire.firstIndex(of: "history:\(admissionReads + 1):returned"))
            let send = try #require(wire.firstIndex(of: "send:\(fresh.operationID.uuidString)"))
            #expect(read < send)
            #expect(vm.input == "preserved reset draft")
        } catch {
            await fixture.transport.release()
            _ = await submitting?.value
            await resetting?.value
            await fixture.close()
            throw error
        }
        await fixture.transport.release()
        _ = await submitting?.value
        await resetting?.value
        await fixture.close()
    }

    @Test(arguments: ["history", "final-route"], [
        "metadata", "renewed metadata", "patch", "completed patch", "branch", "session", "route", "presentation",
        "cancel",
    ])
    func `exact settings admission rejects retirement across either suspension`(
        phase: String, change: String) async throws
    {
        let gate = NativeSubmissionGate()
        let patchGate = NativeSubmissionGate()
        let bootstrapGate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            historyGate: bootstrapGate,
            snapshotGate: phase == "history" ? gate : nil,
            validationGate: phase == "final-route" ? gate : nil,
            validationGateCall: 3))
        let presentation = NativeSubmissionPresentation()
        let physical = await fixture.transport.route(fixture.target)
        let route = OpenClawChatExternalSubmissionRoute(
            target: fixture.target, lease: physical.lease,
            accountIsCurrent: physical.accountIsCurrent,
            presentationIsCurrent: { presentation.isCurrent })
        let target = fixture.vm.currentModelPatchTarget()
        fixture.vm.input = "preserved draft"
        let invocation = fixture.request()
        let task = Task { await fixture.vm.submit(invocation, using: route) }
        do {
            try await waitUntil("exact settings admission suspended") { await gate.entered }
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.targetedHistoryReturns == (phase == "history" ? [] : [1]))
            #expect(await fixture.transport.sent.isEmpty)
            #expect(fixture.vm.pendingRunCount == 1)
            switch change {
            case "metadata", "renewed metadata":
                fixture.vm.invalidateSessionMetadataReadiness()
                if change == "renewed metadata" {
                    fixture.vm.readySessionMetadataGeneration = fixture.vm.sessionMetadataGeneration
                }
            case "patch", "completed patch":
                let requestID = fixture.vm.reserveSessionSettingsRequest(for: target)
                fixture.vm.enqueueSessionSettingsPatch(requestID: requestID, target: target) { _ in
                    await patchGate.wait()
                }
                if change == "completed patch" {
                    await patchGate.open()
                    await fixture.vm.waitForPendingSessionSettings(for: target)
                }
            case "branch": fixture.vm.nextSessionBranchSwitchGeneration &+= 1
            case "session":
                fixture.vm.switchSession(to: "agent:agent-a:other", agentID: fixture.target.agentID)
                fixture.vm.detachTransport()
            case "route": await fixture.transport.invalidate()
            case "presentation": presentation.isCurrent = false
            default: task.cancel()
            }
            await gate.open()
            let result = await task.value
            if change == "cancel" {
                #expect(result == .cancelled)
            } else if case .notDispatched = result {} else {
                Issue.record("A retired settings snapshot cannot authorize a send")
            }
            #expect(await fixture.transport.sent.isEmpty)
            #expect(fixture.vm.pendingRunCount == 0)
            #expect(fixture.vm.pendingLocalUserEchoMessageIDsByRunID[invocation.operationID.uuidString] == nil)
            #expect(fixture.vm.runMessageScopesByRunID[invocation.operationID.uuidString] == nil)
            if change != "session" { #expect(fixture.vm.input == "preserved draft") }
            #expect(!fixture.vm.isSending && !fixture.vm.isSubmittingDraft)
            _ = await fixture.vm.submit(invocation, using: route)
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.sent.isEmpty)
        } catch {
            await gate.open()
            await patchGate.open()
            await fixture.transport.release()
            _ = await task.value
            await fixture.vm.waitForPendingSessionSettings(for: target)
            await fixture.close()
            throw error
        }
        await patchGate.open()
        await fixture.vm.waitForPendingSessionSettings(for: target)
        await fixture.close()
    }

    @Test
    func `duplicate confirmation joins the same exact settings read and never rereads on replay`() async throws {
        let gate = NativeSubmissionGate()
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(
            response: .rejected, snapshotGate: gate))
        let route = await fixture.transport.route(fixture.target)
        let invocation = fixture.request()
        let first = Task { await fixture.vm.submit(invocation, using: route) }
        var duplicate: Task<OpenClawChatSubmissionOutcome, Never>?
        do {
            try await waitUntil("exact settings read entered") { await gate.entered }
            let validations = await fixture.transport.validationCalls
            let joined = Task { await fixture.vm.submit(invocation, using: route) }
            duplicate = joined
            try await waitUntil("duplicate joined settings owner") {
                await fixture.transport.validationCalls > validations
            }
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.sent.isEmpty)
            await gate.open()
            let result = await first.value
            if case .rejected = result {} else { Issue.record("Expected the single admitted send's rejection") }
            #expect(await joined.value == result)
            #expect(await fixture.vm.submit(invocation, using: route) == result)
            #expect(await fixture.transport.wireEvents == [
                "history:1:started", "history:1:returned", "send:\(invocation.operationID.uuidString)",
            ])
            #expect(await fixture.transport.targetedHistoryRequests.count == 1)
            #expect(await fixture.transport.targetedHistoryReturns == [1])
            #expect(await fixture.transport.sent.count == 1)
        } catch {
            await gate.open()
            _ = await first.value
            _ = await duplicate?.value
            await fixture.close()
            throw error
        }
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
        let fixture = try NativeSubmissionFixture(transport: NativeSubmissionTransport(ackStatus: status))
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
