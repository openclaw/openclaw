import OpenClawKit
import Foundation
import Testing
@testable import OpenClawChatUI

private struct TimeoutError: Error, CustomStringConvertible {
    let label: String
    var description: String { "Timeout waiting for: \(self.label)" }
}

private func waitUntil(
    _ label: String,
    timeoutSeconds: Double = 2.0,
    pollMs: UInt64 = 10,
    _ condition: @escaping @Sendable () async -> Bool) async throws
{
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        if await condition() {
            return
        }
        try await Task.sleep(nanoseconds: pollMs * 1_000_000)
    }
    throw TimeoutError(label: label)
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
        let history1 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: sessionId,
            messages: [],
            thinkingLevel: "off")
        let history2 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: sessionId,
            messages: [
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "final answer"]],
                    "timestamp": Date().timeIntervalSince1970 * 1000,
                ]),
            ],
            thinkingLevel: "off")

        let transport = TestChatTransport(historyResponses: [history1, history2])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK && vm.sessionId == sessionId } }

        await MainActor.run {
            vm.input = "hi"
            vm.send()
        }
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        transport.emit(
            .agent(
                OpenClawAgentEventPayload(
                    runId: sessionId,
                    seq: 1,
                    stream: "assistant",
                    ts: Int(Date().timeIntervalSince1970 * 1000),
                    data: ["text": AnyCodable("streaming…")])))

        try await waitUntil("assistant stream visible") {
            await MainActor.run { vm.streamingAssistantText == "streaming…" }
        }

        transport.emit(
            .agent(
                OpenClawAgentEventPayload(
                    runId: sessionId,
                    seq: 2,
                    stream: "tool",
                    ts: Int(Date().timeIntervalSince1970 * 1000),
                    data: [
                        "phase": AnyCodable("start"),
                        "name": AnyCodable("demo"),
                        "toolCallId": AnyCodable("t1"),
                        "args": AnyCodable(["x": 1]),
                    ])))

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
        let history1 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off")
        let history2 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "from history"]],
                    "timestamp": Date().timeIntervalSince1970 * 1000,
                ]),
            ],
            thinkingLevel: "off")

        let transport = TestChatTransport(historyResponses: [history1, history2])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK } }

        await MainActor.run {
            vm.input = "hi"
            vm.send()
        }
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
        let history1 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "user",
                    "content": [["type": "text", "text": "first"]],
                    "timestamp": now,
                ]),
            ],
            thinkingLevel: "off")
        let history2 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "user",
                    "content": [["type": "text", "text": "first"]],
                    "timestamp": now,
                ]),
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "from external run"]],
                    "timestamp": now + 1,
                ]),
            ],
            thinkingLevel: "off")

        let transport = TestChatTransport(historyResponses: [history1, history2])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.messages.count == 1 } }

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
        let history1 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "user",
                    "content": [["type": "text", "text": "hello"]],
                    "timestamp": now,
                ]),
            ],
            thinkingLevel: "off")
        let history2 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "user",
                    "content": [["type": "text", "text": "hello"]],
                    "timestamp": now,
                ]),
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "world"]],
                    "timestamp": now + 1,
                ]),
            ],
            thinkingLevel: "off")

        let transport = TestChatTransport(historyResponses: [history1, history2])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.messages.count == 1 } }
        let firstIdBefore = try #require(await MainActor.run { vm.messages.first?.id })

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: "other-run",
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("history refresh") { await MainActor.run { vm.messages.count == 2 } }
        let firstIdAfter = try #require(await MainActor.run { vm.messages.first?.id })
        #expect(firstIdAfter == firstIdBefore)
    }

    @Test func clearsStreamingOnExternalFinalEvent() async throws {
        let sessionId = "sess-main"
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: sessionId,
            messages: [],
            thinkingLevel: "off")
        let transport = TestChatTransport(historyResponses: [history, history])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK && vm.sessionId == sessionId } }

        transport.emit(
            .agent(
                OpenClawAgentEventPayload(
                    runId: sessionId,
                    seq: 1,
                    stream: "assistant",
                    ts: Int(Date().timeIntervalSince1970 * 1000),
                    data: ["text": AnyCodable("external stream")])))

        transport.emit(
            .agent(
                OpenClawAgentEventPayload(
                    runId: sessionId,
                    seq: 2,
                    stream: "tool",
                    ts: Int(Date().timeIntervalSince1970 * 1000),
                    data: [
                        "phase": AnyCodable("start"),
                        "name": AnyCodable("demo"),
                        "toolCallId": AnyCodable("t1"),
                        "args": AnyCodable(["x": 1]),
                    ])))

        try await waitUntil("streaming active") {
            await MainActor.run { vm.streamingAssistantText == "external stream" }
        }
        try await waitUntil("tool call pending") { await MainActor.run { vm.pendingToolCalls.count == 1 } }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: "other-run",
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))

        try await waitUntil("streaming cleared") { await MainActor.run { vm.streamingAssistantText == nil } }
        #expect(await MainActor.run { vm.pendingToolCalls.isEmpty })
    }

    @Test func seqGapClearsPendingRunsAndAutoRefreshesHistory() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off")
        let history2 = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "resynced after gap"]],
                    "timestamp": now,
                ]),
            ],
            thinkingLevel: "off")

        let transport = TestChatTransport(historyResponses: [history1, history2])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK } }

        await MainActor.run {
            vm.input = "hello"
            vm.send()
        }
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
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off")
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 4,
            defaults: nil,
            sessions: [
                OpenClawChatSessionEntry(
                    key: "recent-1",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: recent,
                    sessionId: nil,
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: nil,
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    model: nil,
                    contextTokens: nil),
                OpenClawChatSessionEntry(
                    key: "main",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: stale,
                    sessionId: nil,
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: nil,
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    model: nil,
                    contextTokens: nil),
                OpenClawChatSessionEntry(
                    key: "recent-2",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: recentOlder,
                    sessionId: nil,
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: nil,
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    model: nil,
                    contextTokens: nil),
                OpenClawChatSessionEntry(
                    key: "old-1",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: stale,
                    sessionId: nil,
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: nil,
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    model: nil,
                    contextTokens: nil),
            ])

        let transport = TestChatTransport(
            historyResponses: [history],
            sessionsResponses: [sessions])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["main", "recent-1", "recent-2"])
    }

    @Test func sessionChoicesIncludeCurrentWhenMissing() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let recent = now - (30 * 60 * 1000)
        let history = OpenClawChatHistoryPayload(
            sessionKey: "custom",
            sessionId: "sess-custom",
            messages: [],
            thinkingLevel: "off")
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                OpenClawChatSessionEntry(
                    key: "main",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: recent,
                    sessionId: nil,
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: nil,
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    model: nil,
                    contextTokens: nil),
            ])

        let transport = TestChatTransport(
            historyResponses: [history],
            sessionsResponses: [sessions])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "custom", transport: transport) }
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["main", "custom"])
    }

    @Test func clearsStreamingOnExternalErrorEvent() async throws {
        let sessionId = "sess-main"
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: sessionId,
            messages: [],
            thinkingLevel: "off")
        let transport = TestChatTransport(historyResponses: [history, history])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK && vm.sessionId == sessionId } }

        transport.emit(
            .agent(
                OpenClawAgentEventPayload(
                    runId: sessionId,
                    seq: 1,
                    stream: "assistant",
                    ts: Int(Date().timeIntervalSince1970 * 1000),
                    data: ["text": AnyCodable("external stream")])))

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
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: sessionId,
            messages: [],
            thinkingLevel: "off")
        let transport = TestChatTransport(historyResponses: [history, history])
        let vm = await MainActor.run { OpenClawChatViewModel(sessionKey: "main", transport: transport) }

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap") { await MainActor.run { vm.healthOK && vm.sessionId == sessionId } }

        await MainActor.run {
            vm.input = "hi"
            vm.send()
        }
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
