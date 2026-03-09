import OpenClawKit
import Foundation
import Testing
@testable import OpenClawChatUI

private func chatTextMessage(role: String, text: String, timestamp: Double) -> AnyCodable {
    AnyCodable([
        "role": role,
        "content": [["type": "text", "text": text]],
        "timestamp": timestamp,
    ])
}

private func historyPayload(
    sessionKey: String = "main",
    sessionId: String? = "sess-main",
    messages: [AnyCodable] = []) -> OpenClawChatHistoryPayload
{
    OpenClawChatHistoryPayload(
        sessionKey: sessionKey,
        sessionId: sessionId,
        messages: messages,
        thinkingLevel: "off")
}

private func sessionEntry(key: String, updatedAt: Double) -> OpenClawChatSessionEntry {
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: updatedAt,
        sessionId: nil,
        systemSent: nil,
        abortedLastRun: nil,
        thinkingLevel: nil,
        verboseLevel: nil,
        inputTokens: nil,
        outputTokens: nil,
        totalTokens: nil,
        model: nil,
        contextTokens: nil)
}

private func makeViewModel(
    sessionKey: String = "main",
    historyResponses: [OpenClawChatHistoryPayload],
    sessionsResponses: [OpenClawChatSessionsListResponse] = []) async -> (TestChatTransport, OpenClawChatViewModel)
{
    let transport = TestChatTransport(historyResponses: historyResponses, sessionsResponses: sessionsResponses)
    let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: sessionKey, transport: transport) }
    return (transport, vm)
}

private func loadAndWaitBootstrap(
    vm: OpenClawChatViewModel,
    sessionId: String? = nil) async throws
{
    await MainActor.run { vm.load() }
    try await waitUntil("bootstrap") {
        await MainActor.run {
            vm.healthOK && (sessionId == nil || vm.sessionId == sessionId)
        }
    }
}

private func sendUserMessage(_ vm: OpenClawChatViewModel, text: String = "hi") async {
    await MainActor.run {
        vm.input = text
        vm.send()
    }
}

private func emitAssistantText(
    transport: TestChatTransport,
    runId: String,
    text: String,
    seq: Int = 1)
{
    transport.emit(
        .agent(
            OpenClawAgentEventPayload(
                runId: runId,
                seq: seq,
                stream: "assistant",
                ts: Int(Date().timeIntervalSince1970 * 1000),
                data: ["text": AnyCodable(text)])))
}

private func emitToolStart(
    transport: TestChatTransport,
    runId: String,
    seq: Int = 2)
{
    transport.emit(
        .agent(
            OpenClawAgentEventPayload(
                runId: runId,
                seq: seq,
                stream: "tool",
                ts: Int(Date().timeIntervalSince1970 * 1000),
                data: [
                    "phase": AnyCodable("start"),
                    "name": AnyCodable("demo"),
                    "toolCallId": AnyCodable("t1"),
                    "args": AnyCodable(["x": 1]),
                ])))
}

private func emitExternalFinal(
    transport: TestChatTransport,
    runId: String = "other-run",
    sessionKey: String = "main")
{
    transport.emit(
        .chat(
            OpenClawChatEventPayload(
                runId: runId,
                sessionKey: sessionKey,
                state: "final",
                message: nil,
                errorMessage: nil)))
}

private actor TestChatTransportState {
    var historyCallCount: Int = 0
    var sessionsCallCount: Int = 0
    var sentRunIds: [String] = []
    var abortedRunIds: [String] = []
}

private final class TestChatTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state = TestChatTransportState()
    private let historyResponses: [OpenClawChatHistoryPayload]
    private let sessionsResponses: [OpenClawChatSessionsListResponse]

    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(
        historyResponses: [OpenClawChatHistoryPayload],
        sessionsResponses: [OpenClawChatSessionsListResponse] = [])
    {
        self.historyResponses = historyResponses
        self.sessionsResponses = sessionsResponses
        var cont: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { c in
            cont = c
        }
        self.continuation = cont
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func setActiveSessionKey(_: String) async throws {}

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let idx = await self.state.historyCallCount
        await self.state.setHistoryCallCount(idx + 1)
        if idx < self.historyResponses.count {
            return self.historyResponses[idx]
        }
        return self.historyResponses.last ?? OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: nil,
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.state.sentRunIdsAppend(idempotencyKey)
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "ok")
    }

    func abortRun(sessionKey _: String, runId: String) async throws {
        await self.state.abortedRunIdsAppend(runId)
    }

    func listSessions(limit _: Int?) async throws -> OpenClawChatSessionsListResponse {
        let idx = await self.state.sessionsCallCount
        await self.state.setSessionsCallCount(idx + 1)
        if idx < self.sessionsResponses.count {
            return self.sessionsResponses[idx]
        }
        return self.sessionsResponses.last ?? OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: 0,
            defaults: nil,
            sessions: [])
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func emit(_ evt: OpenClawChatTransportEvent) {
        self.continuation.yield(evt)
    }

    func lastSentRunId() async -> String? {
        let ids = await self.state.sentRunIds
        return ids.last
    }

    func abortedRunIds() async -> [String] {
        await self.state.abortedRunIds
    }
}

extension TestChatTransportState {
    fileprivate func setHistoryCallCount(_ v: Int) {
        self.historyCallCount = v
    }

    fileprivate func setSessionsCallCount(_ v: Int) {
        self.sessionsCallCount = v
    }

    fileprivate func sentRunIdsAppend(_ v: String) {
        self.sentRunIds.append(v)
    }

    fileprivate func abortedRunIdsAppend(_ v: String) {
        self.abortedRunIds.append(v)
    }
}

@Suite struct ChatViewModelTests {
    @Test func streamsAssistantAndClearsOnFinal() async throws {
        let sessionId = "sess-main"
        let history1 = historyPayload(sessionId: sessionId)
        let history2 = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "final answer",
                    timestamp: Date().timeIntervalSince1970 * 1000),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [history1, history2])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        emitAssistantText(transport: transport, runId: sessionId, text: "streaming…")

        try await waitUntil("assistant stream visible") {
            await MainActor.run { vm.streamingAssistantText == "streaming…" }
        }

        emitToolStart(transport: transport, runId: sessionId)

        try await waitUntil("tool call pending") { await MainActor.run { vm.pendingToolCalls.count == 1 } }

        let runId = try #require(await transport.lastSentRunId())
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("pending run clears") { await MainActor.run { vm.pendingRunCount == 0 } }
        try await waitUntil("history refresh") {
            await MainActor.run { vm.messages.contains(where: { $0.role == "assistant" }) }
        }
        #expect(await MainActor.run { vm.streamingAssistantText } == nil)
        #expect(await MainActor.run { vm.pendingToolCalls.isEmpty })
    }

    @Test func acceptsCanonicalSessionKeyEventsForOwnPendingRun() async throws {
        let history1 = historyPayload()
        let history2 = historyPayload(
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "from history",
                    timestamp: Date().timeIntervalSince1970 * 1000),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [history1, history2])
        try await loadAndWaitBootstrap(vm: vm)
        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        let runId = try #require(await transport.lastSentRunId())
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "agent:main:main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("pending run clears") { await MainActor.run { vm.pendingRunCount == 0 } }
        try await waitUntil("history refresh") {
            await MainActor.run { vm.messages.contains(where: { $0.role == "assistant" }) }
        }
    }

    @Test func acceptsCanonicalSessionKeyEventsForExternalRuns() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload(messages: [chatTextMessage(role: "user", text: "first", timestamp: now)])
        let history2 = historyPayload(
            messages: [
                chatTextMessage(role: "user", text: "first", timestamp: now),
                chatTextMessage(role: "assistant", text: "from external run", timestamp: now + 1),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [history1, history2])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.count == 1 } }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: "external-run",
                    sessionKey: "agent:main:main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("history refresh after canonical external event") {
            await MainActor.run { vm.messages.count == 2 }
        }
    }

    @Test func preservesMessageIDsAcrossHistoryRefreshes() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload(messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)])
        let history2 = historyPayload(
            messages: [
                chatTextMessage(role: "user", text: "hello", timestamp: now),
                chatTextMessage(role: "assistant", text: "world", timestamp: now + 1),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [history1, history2])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.count == 1 } }
        let firstIdBefore = try #require(await MainActor.run { vm.messages.first?.id })

        emitExternalFinal(transport: transport)

        try await waitUntil("history refresh") { await MainActor.run { vm.messages.count == 2 } }
        let firstIdAfter = try #require(await MainActor.run { vm.messages.first?.id })
        #expect(firstIdAfter == firstIdBefore)
    }

    @Test func clearsStreamingOnExternalFinalEvent() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(historyResponses: [history, history])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        emitAssistantText(transport: transport, runId: sessionId, text: "external stream")
        emitToolStart(transport: transport, runId: sessionId)

        try await waitUntil("streaming active") {
            await MainActor.run { vm.streamingAssistantText == "external stream" }
        }
        try await waitUntil("tool call pending") { await MainActor.run { vm.pendingToolCalls.count == 1 } }

        emitExternalFinal(transport: transport)

        try await waitUntil("streaming cleared") { await MainActor.run { vm.streamingAssistantText == nil } }
        #expect(await MainActor.run { vm.pendingToolCalls.isEmpty })
    }

    @Test func seqGapClearsPendingRunsAndAutoRefreshesHistory() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload()
        let history2 = historyPayload(messages: [chatTextMessage(role: "assistant", text: "resynced after gap", timestamp: now)])

        let (transport, vm) = await makeViewModel(historyResponses: [history1, history2])

        try await loadAndWaitBootstrap(vm: vm)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        transport.emit(.seqGap)

        try await waitUntil("pending run clears on seqGap") {
            await MainActor.run { vm.pendingRunCount == 0 }
        }
        try await waitUntil("history refreshes on seqGap") {
            await MainActor.run { vm.messages.contains(where: { $0.role == "assistant" }) }
        }
        #expect(await MainActor.run { vm.errorText == nil })
    }

    @Test func sessionChoicesPreferMainAndRecent() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let recent = now - (2 * 60 * 60 * 1000)
        let recentOlder = now - (5 * 60 * 60 * 1000)
        let stale = now - (26 * 60 * 60 * 1000)
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 4,
            defaults: nil,
            sessions: [
                sessionEntry(key: "recent-1", updatedAt: recent),
                sessionEntry(key: "main", updatedAt: stale),
                sessionEntry(key: "recent-2", updatedAt: recentOlder),
                sessionEntry(key: "old-1", updatedAt: stale),
            ])

        let (_, vm) = await makeViewModel(historyResponses: [history], sessionsResponses: [sessions])
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["main", "recent-1", "recent-2"])
    }

    @Test func sessionChoicesIncludeCurrentWhenMissing() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let recent = now - (30 * 60 * 1000)
        let history = historyPayload(sessionKey: "custom", sessionId: "sess-custom")
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: recent),
            ])

        let (_, vm) = await makeViewModel(
            sessionKey: "custom",
            historyResponses: [history],
            sessionsResponses: [sessions])
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["main", "custom"])
    }

    @Test func clearsStreamingOnExternalErrorEvent() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(historyResponses: [history, history])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        emitAssistantText(transport: transport, runId: sessionId, text: "external stream")

        try await waitUntil("streaming active") {
            await MainActor.run { vm.streamingAssistantText == "external stream" }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: "other-run",
                    sessionKey: "main",
                    state: "error",
                    message: nil,
                    errorMessage: "boom")))

        try await waitUntil("streaming cleared") { await MainActor.run { vm.streamingAssistantText == nil } }
    }

    @Test func stripsInboundMetadataFromHistoryMessages() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "user",
                    "content": [["type": "text", "text": """
Conversation info (untrusted metadata):
```json
{ \"sender\": \"openclaw-ios\" }
```

Hello?
"""]],
                    "timestamp": Date().timeIntervalSince1970 * 1000,
                ]),
            ],
            thinkingLevel: "off")
        let transport = TestChatTransport(historyResponses: [history])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("history loaded") { await MainActor.run { !vm.messages.isEmpty } }

        let sanitized = await MainActor.run { vm.messages.first?.content.first?.text }
        #expect(sanitized == "Hello?")
    }

    @Test func abortRequestsDoNotClearPendingUntilAbortedEvent() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(historyResponses: [history, history])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        let runId = try #require(await transport.lastSentRunId())
        await MainActor.run { vm.abort() }

        try await waitUntil("abortRun called") {
            let ids = await transport.abortedRunIds()
            return ids == [runId]
        }

        // Pending remains until the gateway broadcasts an aborted/final chat event.
        #expect(await MainActor.run { vm.pendingRunCount } == 1)

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "aborted",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("pending run clears") { await MainActor.run { vm.pendingRunCount == 0 } }
    }
}
