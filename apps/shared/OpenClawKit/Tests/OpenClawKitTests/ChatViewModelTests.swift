import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private func chatTextMessage(
    role: String,
    text: String,
    timestamp: Double,
    contentId: String? = nil,
    idempotencyKey: String? = nil) -> AnyCodable
{
    var content: [String: Any] = ["type": "text", "text": text]
    if let contentId {
        content["id"] = contentId
    }
    var message: [String: Any] = [
        "role": role,
        "content": [content],
        "timestamp": timestamp,
    ]
    if let idempotencyKey {
        message["__openclaw"] = ["idempotencyKey": idempotencyKey]
    }
    return AnyCodable(message)
}

private func chatTextModelMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> OpenClawChatMessage
{
    OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp,
        idempotencyKey: idempotencyKey)
}

private func chatErrorMessage(role: String, errorMessage: String, timestamp: Double) -> AnyCodable {
    AnyCodable([
        "role": role,
        "content": [],
        "timestamp": timestamp,
        "stopReason": "error",
        "errorMessage": errorMessage,
    ])
}

extension [OpenClawChatMessage] {
    fileprivate func containsUserText(_ text: String) -> Bool {
        self.contains { message in
            message.role == "user" &&
                message.content.contains { $0.text == text }
        }
    }
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
        modelProvider: nil,
        model: nil,
        contextTokens: nil)
}

private func thinkingOption(_ id: String, label: String? = nil) -> OpenClawChatThinkingLevelOption {
    OpenClawChatThinkingLevelOption(id: id, label: label ?? id)
}

private func sessionEntry(
    key: String,
    updatedAt: Double,
    model: String?,
    modelProvider: String? = nil) -> OpenClawChatSessionEntry
{
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
        modelProvider: modelProvider,
        model: model,
        contextTokens: nil)
}

private func modelChoice(id: String, name: String, provider: String = "anthropic") -> OpenClawChatModelChoice {
    OpenClawChatModelChoice(modelID: id, name: name, provider: provider, contextWindow: nil)
}

private func commandChoice(
    name: String,
    aliases: [String],
    description: String = "",
    source: OpenClawChatCommandChoice.Source = .command,
    acceptsArgs: Bool = false) -> OpenClawChatCommandChoice
{
    OpenClawChatCommandChoice(
        id: "\(source.rawValue):\(name)",
        name: name,
        textAliases: aliases,
        description: description,
        source: source,
        acceptsArgs: acceptsArgs)
}

private func makeViewModel(
    sessionKey: String = "main",
    historyResponses: [OpenClawChatHistoryPayload],
    sessionsResponses: [OpenClawChatSessionsListResponse] = [],
    modelResponses: [[OpenClawChatModelChoice]] = [],
    commandResponses: [[OpenClawChatCommandChoice]] = [],
    requestHistoryHook: (@Sendable (String) async throws -> Void)? = nil,
    historyResponseHook: (@Sendable (String, Int, [String]) async throws -> OpenClawChatHistoryPayload?)? = nil,
    setActiveSessionHook: (@Sendable (String) async throws -> Void)? = nil,
    createSessionHook: (@Sendable (String, String?) async throws -> Void)? = nil,
    resetSessionHook: (@Sendable (String) async throws -> Void)? = nil,
    compactSessionHook: (@Sendable (String) async throws -> Void)? = nil,
    setSessionModelHook: (@Sendable (String?) async throws -> Void)? = nil,
    setSessionThinkingHook: (@Sendable (String) async throws -> Void)? = nil,
    sendMessageHook: (@Sendable (String) async throws -> OpenClawChatSendResponse)? = nil,
    sendMessageStatus: String = "ok",
    waitForRunCompletionHook: (@Sendable (String, Int) async -> Bool)? = nil,
    healthResponses: [Bool] = [true],
    initialThinkingLevel: String? = nil,
    onSessionChanged: (@MainActor (String) -> Void)? = nil,
    onThinkingLevelChanged: (@MainActor @Sendable (String) -> Void)? = nil) async
    -> (TestChatTransport, OpenClawChatViewModel)
{
    let transport = TestChatTransport(
        historyResponses: historyResponses,
        sessionsResponses: sessionsResponses,
        modelResponses: modelResponses,
        commandResponses: commandResponses,
        requestHistoryHook: requestHistoryHook,
        historyResponseHook: historyResponseHook,
        setActiveSessionHook: setActiveSessionHook,
        createSessionHook: createSessionHook,
        resetSessionHook: resetSessionHook,
        compactSessionHook: compactSessionHook,
        setSessionModelHook: setSessionModelHook,
        setSessionThinkingHook: setSessionThinkingHook,
        sendMessageHook: sendMessageHook,
        sendMessageStatus: sendMessageStatus,
        waitForRunCompletionHook: waitForRunCompletionHook,
        healthResponses: healthResponses)
    let vm = await MainActor.run {
        OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            initialThinkingLevel: initialThinkingLevel,
            onSessionChanged: onSessionChanged,
            onThinkingLevelChanged: onThinkingLevelChanged)
    }
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

private func waitForLastSentRunId(_ transport: TestChatTransport) async throws -> String {
    try await waitUntil("transport send called") {
        await transport.lastSentRunId() != nil
    }
    return try #require(await transport.lastSentRunId())
}

private func waitForSentRunId(after sentRunCount: Int, _ transport: TestChatTransport) async throws -> String {
    try await waitUntil("transport send called") {
        await transport.sentRunIds().count > sentRunCount
    }
    return try #require(await transport.sentRunIds().last)
}

@discardableResult
private func sendMessageAndEmitFinal(
    transport: TestChatTransport,
    vm: OpenClawChatViewModel,
    text: String,
    sessionKey: String = "main") async throws -> String
{
    let sentRunCount = await transport.sentRunIds().count
    await sendUserMessage(vm, text: text)
    let runId = try await waitForSentRunId(after: sentRunCount, transport)
    try await waitUntil("send is pending or refreshed") {
        await MainActor.run {
            vm.pendingRunCount == 1 || (!vm.isSending && vm.pendingRunCount == 0)
        }
    }

    transport.emit(
        .chat(
            OpenClawChatEventPayload(
                runId: runId,
                sessionKey: sessionKey,
                state: "final",
                message: nil,
                errorMessage: nil)))
    return runId
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

private func emitAgentLifecycleEnd(
    transport: TestChatTransport,
    runId: String,
    seq: Int = 3)
{
    transport.emit(
        .agent(
            OpenClawAgentEventPayload(
                runId: runId,
                seq: seq,
                stream: "lifecycle",
                ts: Int(Date().timeIntervalSince1970 * 1000),
                data: ["phase": AnyCodable("end")])))
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

@MainActor
private final class CallbackBox {
    var values: [String] = []
}

private actor AsyncGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var isOpen = false

    func wait() async {
        guard !self.isOpen else { return }
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func open() {
        self.isOpen = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private actor AsyncCounter {
    private var value: Int

    init(_ initialValue: Int = 0) {
        self.value = initialValue
    }

    func increment() -> Int {
        self.value += 1
        return self.value
    }

    func current() -> Int {
        self.value
    }
}

private actor SessionSubscribeGate {
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func release() {
        let waiters = self.waiters
        self.waiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }
}

private actor TestChatTransportState {
    var historyCallCount: Int = 0
    var sessionsCallCount: Int = 0
    var modelsCallCount: Int = 0
    var commandsCallCount: Int = 0
    var healthCallCount: Int = 0
    var activeSessionKeys: [String] = []
    var createdSessionKeys: [String] = []
    var createdParentSessionKeys: [String?] = []
    var resetSessionKeys: [String] = []
    var compactSessionKeys: [String] = []
    var sentSessionKeys: [String] = []
    var sentMessages: [String] = []
    var sentRunIds: [String] = []
    var commandSessionKeys: [String] = []
    var sentThinkingLevels: [String] = []
    var abortedRunIds: [String] = []
    var waitCompletionRunIds: [String] = []
    var patchedModels: [String?] = []
    var patchedThinkingLevels: [String] = []
}

private final class TestChatTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state = TestChatTransportState()
    private let historyResponses: [OpenClawChatHistoryPayload]
    private let sessionsResponses: [OpenClawChatSessionsListResponse]
    private let modelResponses: [[OpenClawChatModelChoice]]
    private let commandResponses: [[OpenClawChatCommandChoice]]
    private let requestHistoryHook: (@Sendable (String) async throws -> Void)?
    private let historyResponseHook:
        (@Sendable (String, Int, [String]) async throws -> OpenClawChatHistoryPayload?)?
    private let setActiveSessionHook: (@Sendable (String) async throws -> Void)?
    private let createSessionHook: (@Sendable (String, String?) async throws -> Void)?
    private let resetSessionHook: (@Sendable (String) async throws -> Void)?
    private let compactSessionHook: (@Sendable (String) async throws -> Void)?
    private let setSessionModelHook: (@Sendable (String?) async throws -> Void)?
    private let setSessionThinkingHook: (@Sendable (String) async throws -> Void)?
    private let sendMessageHook: (@Sendable (String) async throws -> OpenClawChatSendResponse)?
    private let sendMessageStatus: String
    private let waitForRunCompletionHook: (@Sendable (String, Int) async -> Bool)?
    private let healthResponses: [Bool]

    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(
        historyResponses: [OpenClawChatHistoryPayload],
        sessionsResponses: [OpenClawChatSessionsListResponse] = [],
        modelResponses: [[OpenClawChatModelChoice]] = [],
        commandResponses: [[OpenClawChatCommandChoice]] = [],
        requestHistoryHook: (@Sendable (String) async throws -> Void)? = nil,
        historyResponseHook: (@Sendable (String, Int, [String]) async throws -> OpenClawChatHistoryPayload?)? = nil,
        setActiveSessionHook: (@Sendable (String) async throws -> Void)? = nil,
        createSessionHook: (@Sendable (String, String?) async throws -> Void)? = nil,
        resetSessionHook: (@Sendable (String) async throws -> Void)? = nil,
        compactSessionHook: (@Sendable (String) async throws -> Void)? = nil,
        setSessionModelHook: (@Sendable (String?) async throws -> Void)? = nil,
        setSessionThinkingHook: (@Sendable (String) async throws -> Void)? = nil,
        sendMessageHook: (@Sendable (String) async throws -> OpenClawChatSendResponse)? = nil,
        sendMessageStatus: String = "ok",
        waitForRunCompletionHook: (@Sendable (String, Int) async -> Bool)? = nil,
        healthResponses: [Bool] = [true])
    {
        self.historyResponses = historyResponses
        self.sessionsResponses = sessionsResponses
        self.modelResponses = modelResponses
        self.commandResponses = commandResponses
        self.requestHistoryHook = requestHistoryHook
        self.historyResponseHook = historyResponseHook
        self.setActiveSessionHook = setActiveSessionHook
        self.createSessionHook = createSessionHook
        self.resetSessionHook = resetSessionHook
        self.compactSessionHook = compactSessionHook
        self.setSessionModelHook = setSessionModelHook
        self.setSessionThinkingHook = setSessionThinkingHook
        self.sendMessageHook = sendMessageHook
        self.sendMessageStatus = sendMessageStatus
        self.waitForRunCompletionHook = waitForRunCompletionHook
        self.healthResponses = healthResponses
        var cont: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { c in
            cont = c
        }
        self.continuation = cont
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        await self.state.activeSessionKeysAppend(sessionKey)
        if let setActiveSessionHook {
            try await setActiveSessionHook(sessionKey)
        }
    }

    func createSession(
        key: String,
        label _: String?,
        parentSessionKey: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        if let createSessionHook {
            try await createSessionHook(key, parentSessionKey)
        }
        await self.state.createdSessionKeysAppend(key)
        await self.state.createdParentSessionKeysAppend(parentSessionKey)
        return OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: "created-\(key)")
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let idx = await self.state.nextHistoryCallIndex()
        if let requestHistoryHook {
            try await requestHistoryHook(sessionKey)
        }
        if let historyResponseHook {
            let sentRunIds = await self.sentRunIds()
            if let response = try await historyResponseHook(sessionKey, idx, sentRunIds) {
                return response
            }
        }
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
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.state.sentSessionKeysAppend(sessionKey)
        await self.state.sentMessagesAppend(message)
        await self.state.sentRunIdsAppend(idempotencyKey)
        await self.state.sentThinkingLevelsAppend(thinking)
        if let sendMessageHook {
            return try await sendMessageHook(idempotencyKey)
        }
        return OpenClawChatSendResponse(runId: idempotencyKey, status: self.sendMessageStatus)
    }

    func abortRun(sessionKey _: String, runId: String) async throws {
        await self.state.abortedRunIdsAppend(runId)
    }

    func listSessions(limit _: Int?) async throws -> OpenClawChatSessionsListResponse {
        let idx = await self.state.nextSessionsCallIndex()
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

    func listModels() async throws -> [OpenClawChatModelChoice] {
        let idx = await self.state.nextModelsCallIndex()
        if idx < self.modelResponses.count {
            return self.modelResponses[idx]
        }
        return self.modelResponses.last ?? []
    }

    var supportsSlashCommandCatalog: Bool {
        !self.commandResponses.isEmpty
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        await self.state.commandSessionKeysAppend(sessionKey)
        let idx = await self.state.nextCommandsCallIndex()
        if idx < self.commandResponses.count {
            return self.commandResponses[idx]
        }
        return self.commandResponses.last ?? []
    }

    func setSessionModel(sessionKey _: String, model: String?) async throws {
        await self.state.patchedModelsAppend(model)
        if let setSessionModelHook = self.setSessionModelHook {
            try await setSessionModelHook(model)
        }
    }

    func resetSession(sessionKey: String) async throws {
        await self.state.resetSessionKeysAppend(sessionKey)
        if let resetSessionHook = self.resetSessionHook {
            try await resetSessionHook(sessionKey)
        }
    }

    func compactSession(sessionKey: String) async throws {
        await self.state.compactSessionKeysAppend(sessionKey)
        if let compactSessionHook = self.compactSessionHook {
            try await compactSessionHook(sessionKey)
        }
    }

    func setSessionThinking(sessionKey _: String, thinkingLevel: String) async throws {
        await self.state.patchedThinkingLevelsAppend(thinkingLevel)
        if let setSessionThinkingHook = self.setSessionThinkingHook {
            try await setSessionThinkingHook(thinkingLevel)
        }
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        let idx = await self.state.nextHealthCallIndex()
        if idx < self.healthResponses.count {
            return self.healthResponses[idx]
        }
        return self.healthResponses.last ?? true
    }

    func waitForRunCompletion(runId: String, timeoutMs: Int) async -> Bool {
        await self.state.waitCompletionRunIdsAppend(runId)
        return await self.waitForRunCompletionHook?(runId, timeoutMs) ?? false
    }

    func emit(_ evt: OpenClawChatTransportEvent) {
        self.continuation.yield(evt)
    }

    func lastSentRunId() async -> String? {
        let ids = await self.state.sentRunIds
        return ids.last
    }

    func sentRunIds() async -> [String] {
        await self.state.sentRunIds
    }

    func sentMessages() async -> [String] {
        await self.state.sentMessages
    }

    func commandSessionKeys() async -> [String] {
        await self.state.commandSessionKeys
    }

    func lastSentSessionKey() async -> String? {
        let keys = await self.state.sentSessionKeys
        return keys.last
    }

    func abortedRunIds() async -> [String] {
        await self.state.abortedRunIds
    }

    func sentThinkingLevels() async -> [String] {
        await self.state.sentThinkingLevels
    }

    func patchedModels() async -> [String?] {
        await self.state.patchedModels
    }

    func activeSessionKeys() async -> [String] {
        await self.state.activeSessionKeys
    }

    func patchedThinkingLevels() async -> [String] {
        await self.state.patchedThinkingLevels
    }

    func healthCallCount() async -> Int {
        await self.state.healthCallCount
    }

    func resetSessionKeys() async -> [String] {
        await self.state.resetSessionKeys
    }

    func compactSessionKeys() async -> [String] {
        await self.state.compactSessionKeys
    }

    func waitCompletionRunIds() async -> [String] {
        await self.state.waitCompletionRunIds
    }

    func createdSessionKeys() async -> [String] {
        await self.state.createdSessionKeys
    }

    func createdParentSessionKeys() async -> [String?] {
        await self.state.createdParentSessionKeys
    }
}

extension TestChatTransportState {
    fileprivate func nextHistoryCallIndex() -> Int {
        defer { self.historyCallCount += 1 }
        return self.historyCallCount
    }

    fileprivate func nextSessionsCallIndex() -> Int {
        defer { self.sessionsCallCount += 1 }
        return self.sessionsCallCount
    }

    fileprivate func nextModelsCallIndex() -> Int {
        defer { self.modelsCallCount += 1 }
        return self.modelsCallCount
    }

    fileprivate func nextCommandsCallIndex() -> Int {
        defer { self.commandsCallCount += 1 }
        return self.commandsCallCount
    }

    fileprivate func nextHealthCallIndex() -> Int {
        defer { self.healthCallCount += 1 }
        return self.healthCallCount
    }

    fileprivate func activeSessionKeysAppend(_ v: String) {
        self.activeSessionKeys.append(v)
    }

    fileprivate func sentRunIdsAppend(_ v: String) {
        self.sentRunIds.append(v)
    }

    fileprivate func commandSessionKeysAppend(_ v: String) {
        self.commandSessionKeys.append(v)
    }

    fileprivate func abortedRunIdsAppend(_ v: String) {
        self.abortedRunIds.append(v)
    }

    fileprivate func waitCompletionRunIdsAppend(_ v: String) {
        self.waitCompletionRunIds.append(v)
    }

    fileprivate func sentThinkingLevelsAppend(_ v: String) {
        self.sentThinkingLevels.append(v)
    }

    fileprivate func patchedModelsAppend(_ v: String?) {
        self.patchedModels.append(v)
    }

    fileprivate func patchedThinkingLevelsAppend(_ v: String) {
        self.patchedThinkingLevels.append(v)
    }

    fileprivate func resetSessionKeysAppend(_ v: String) {
        self.resetSessionKeys.append(v)
    }

    fileprivate func compactSessionKeysAppend(_ v: String) {
        self.compactSessionKeys.append(v)
    }

    fileprivate func createdSessionKeysAppend(_ v: String) {
        self.createdSessionKeys.append(v)
    }

    fileprivate func createdParentSessionKeysAppend(_ v: String?) {
        self.createdParentSessionKeys.append(v)
    }

    fileprivate func sentSessionKeysAppend(_ v: String) {
        self.sentSessionKeys.append(v)
    }

    fileprivate func sentMessagesAppend(_ v: String) {
        self.sentMessages.append(v)
    }
}

struct ChatViewModelTests {
    @Test func `keeps distinct idempotent user turns with identical timestamps and content`() async throws {
        let history = historyPayload(
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same words",
                    timestamp: 1,
                    idempotencyKey: "client-a:user"),
                chatTextMessage(
                    role: "user",
                    text: "same words",
                    timestamp: 1,
                    idempotencyKey: "client-b:user"),
            ])
        let (_, vm) = await makeViewModel(historyResponses: [history])

        try await loadAndWaitBootstrap(vm: vm)

        #expect(await MainActor.run { vm.messages.count } == 2)
    }

    @Test func `timeline revision advances when visible history changes`() async throws {
        let history = historyPayload(
            sessionId: "revision-session",
            messages: [chatTextMessage(role: "user", text: "hello", timestamp: 1)])
        let (_, vm) = await makeViewModel(historyResponses: [history])
        let before = await MainActor.run { vm.timelineRevision }

        try await loadAndWaitBootstrap(vm: vm, sessionId: "revision-session")

        let after = await MainActor.run { vm.timelineRevision }
        #expect(after > before)
    }

    @Test func `timeline revision ignores identical history refresh`() async throws {
        let message = chatTextMessage(role: "user", text: "hello", timestamp: 1)
        let firstHistory = historyPayload(sessionId: "revision-session-1", messages: [message])
        let secondHistory = historyPayload(sessionId: "revision-session-2", messages: [message])
        let (_, vm) = await makeViewModel(historyResponses: [firstHistory, secondHistory])
        try await loadAndWaitBootstrap(vm: vm, sessionId: "revision-session-1")
        let before = await MainActor.run { vm.timelineRevision }

        await MainActor.run { vm.refresh() }
        try await waitUntil("identical history refresh") {
            await MainActor.run { vm.sessionId == "revision-session-2" }
        }

        let after = await MainActor.run { vm.timelineRevision }
        #expect(after == before)
    }

    @Test func `displays error message fallback only for assistant error turns`() throws {
        func decodeMessage(role: String, stopReason: String, contentText: String? = nil) throws -> OpenClawChatMessage {
            let contentJSON = contentText.map { #"[{"type":"text","text":"\#($0)"}]"# } ?? "[]"
            let data = """
            {
              "role": "\(role)",
              "content": \(contentJSON),
              "timestamp": 1,
              "stopReason": "\(stopReason)",
              "errorMessage": "stale provider failure"
            }
            """.data(using: .utf8)!
            return try JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }

        let assistantError = try decodeMessage(role: "assistant", stopReason: "error")
        #expect(assistantError.content.isEmpty)
        #expect(
            OpenClawChatMessage.errorDisplayText(
                role: assistantError.role,
                stopReason: assistantError.stopReason,
                errorMessage: assistantError.errorMessage) == "stale provider failure")
        #expect(
            OpenClawChatMessage.displayText(
                contentText: "",
                role: assistantError.role,
                stopReason: assistantError.stopReason,
                errorMessage: assistantError.errorMessage) == "stale provider failure")

        let sentinelAssistant = try decodeMessage(
            role: "assistant",
            stopReason: "error",
            contentText: "[assistant turn failed before producing content]")
        #expect(
            OpenClawChatMessage.displayText(
                contentText: sentinelAssistant.content.compactMap(\.text).joined(separator: "\n"),
                role: sentinelAssistant.role,
                stopReason: sentinelAssistant.stopReason,
                errorMessage: sentinelAssistant.errorMessage) == "stale provider failure")

        let partialAssistant = try decodeMessage(
            role: "assistant",
            stopReason: "error",
            contentText: "partial answer")
        #expect(
            OpenClawChatMessage.displayText(
                contentText: partialAssistant.content.compactMap(\.text).joined(separator: "\n"),
                role: partialAssistant.role,
                stopReason: partialAssistant.stopReason,
                errorMessage: partialAssistant.errorMessage) == "partial answer")

        let stoppedAssistant = try decodeMessage(role: "assistant", stopReason: "stop")
        #expect(stoppedAssistant.errorMessage == "stale provider failure")
        #expect(stoppedAssistant.content.isEmpty)
        #expect(
            OpenClawChatMessage.errorDisplayText(
                role: stoppedAssistant.role,
                stopReason: stoppedAssistant.stopReason,
                errorMessage: stoppedAssistant.errorMessage) == nil)

        let toolUseAssistant = try decodeMessage(role: "assistant", stopReason: "toolUse")
        #expect(toolUseAssistant.errorMessage == "stale provider failure")
        #expect(toolUseAssistant.content.isEmpty)
        #expect(
            OpenClawChatMessage.errorDisplayText(
                role: toolUseAssistant.role,
                stopReason: toolUseAssistant.stopReason,
                errorMessage: toolUseAssistant.errorMessage) == nil)
    }

    @Test func `streams assistant and clears on final`() async throws {
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

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let runId = try await waitForLastSentRunId(transport)

        emitAssistantText(transport: transport, runId: runId, text: "streaming…")

        try await waitUntil("assistant stream visible") {
            await MainActor.run { vm.streamingAssistantText == "streaming…" }
        }

        emitToolStart(transport: transport, runId: runId)

        try await waitUntil("tool call pending") { await MainActor.run { vm.pendingToolCalls.count == 1 } }

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

    @Test func `renders final chat event message when history is stale`() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let runId = try await waitForLastSentRunId(transport)

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "reply from final event",
                        timestamp: Date().timeIntervalSince1970 * 1000),
                    errorMessage: nil)))

        try await waitUntil("final event message visible") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.role == "assistant" &&
                            message.content.contains { $0.text == "reply from final event" }
                    }
            }
        }
    }

    @Test func `session message adopts provisional final event reply`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 2 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let runId = try await waitForLastSentRunId(transport)

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "dedupe me",
                        timestamp: now + 1,
                        contentId: "live-final-content"),
                    errorMessage: nil)))

        try await waitUntil("provisional final visible once") {
            await MainActor.run {
                vm.messages.count(where: { msg in
                    msg.role == "assistant" && msg.content.first?.text == "dedupe me"
                }) == 1
            }
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(role: "assistant", text: "dedupe me", timestamp: now + 2),
                    messageId: "msg-assistant-final",
                    messageSeq: 2)))

        try await waitUntil("canonical session message adopted final event row") {
            await MainActor.run {
                let matches = vm.messages.filter { msg in
                    msg.role == "assistant" && msg.content.first?.text == "dedupe me"
                }
                return matches.count == 1 && matches.first?.timestamp == now + 2
            }
        }

        await finalRefreshGate.release()
    }

    @Test func `final event does not duplicate canonical assistant session message`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 2 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let runId = try await waitForLastSentRunId(transport)

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(role: "assistant", text: "canonical first", timestamp: now + 2),
                    messageId: "msg-assistant-first",
                    messageSeq: 2)))

        try await waitUntil("canonical assistant visible once") {
            await MainActor.run {
                vm.messages.count(where: { msg in
                    msg.role == "assistant" && msg.content.first?.text == "canonical first"
                }) == 1
            }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(role: "assistant", text: "canonical first", timestamp: now + 1),
                    errorMessage: nil)))

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await MainActor.run {
            let matches = vm.messages.filter { msg in
                msg.role == "assistant" && msg.content.first?.text == "canonical first"
            }
            return matches.count == 1 && matches.first?.timestamp == now + 2
        })

        await finalRefreshGate.release()
    }

    @Test func `later identical session reply does not adopt prior turn provisional final`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageHook: { runId in
                OpenClawChatSendResponse(runId: runId, status: "pending")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "first turn")
        try await waitUntil("first pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let firstRunId = try await waitForLastSentRunId(transport)
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: firstRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(role: "assistant", text: "OK", timestamp: now + 1),
                    errorMessage: nil)))

        try await waitUntil("first provisional final visible") {
            await MainActor.run {
                vm.messages.count(where: { msg in
                    msg.role == "assistant" && msg.content.first?.text == "OK"
                }) == 1
            }
        }

        await sendUserMessage(vm, text: "second turn")
        try await waitUntil("second pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(role: "assistant", text: "OK", timestamp: now + 4),
                    messageId: "msg-second-assistant",
                    messageSeq: 4)))

        try await waitUntil("second identical reply appends after second user") {
            await MainActor.run {
                let okReplies = vm.messages.filter { msg in
                    msg.role == "assistant" && msg.content.first?.text == "OK"
                }
                return okReplies.count == 2 && vm.messages.last?.timestamp == now + 4
            }
        }
    }

    @Test func `completion wait refreshes history and clears pending run`() async throws {
        let sessionId = "sess-main"
        let now = (Date().timeIntervalSince1970 * 1000) + 10000
        let history1 = historyPayload(sessionId: sessionId)
        let history2 = historyPayload(sessionId: sessionId, messages: [])
        let history3 = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "completed after wait",
                    timestamp: now + 60000),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2, history3],
            sendMessageStatus: "pending",
            waitForRunCompletionHook: { _, _ in true })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("agent wait called") {
            await !(transport.waitCompletionRunIds()).isEmpty
        }

        let runId = try await waitForLastSentRunId(transport)
        #expect(await transport.waitCompletionRunIds() == [runId])
        try await waitUntil("completion wait refresh clears pending run") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.role == "assistant" &&
                            message.content.contains { $0.text == "completed after wait" }
                    }
            }
        }
    }

    @Test func `agent lifecycle end refreshes history and clears pending run`() async throws {
        let sessionId = "sess-main"
        let now = (Date().timeIntervalSince1970 * 1000) + 10000
        let history1 = historyPayload(sessionId: sessionId)
        let history2 = historyPayload(sessionId: sessionId, messages: [])
        let history3 = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "completed from lifecycle",
                    timestamp: now + 60000),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2, history3],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }
        let runId = try await waitForLastSentRunId(transport)

        emitAssistantText(transport: transport, runId: runId, text: "streaming reply")
        emitToolStart(transport: transport, runId: runId)
        emitAgentLifecycleEnd(transport: transport, runId: runId)

        try await waitUntil("lifecycle end refresh clears pending run") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.streamingAssistantText == nil &&
                    vm.pendingToolCalls.isEmpty &&
                    vm.messages.contains { message in
                        message.role == "assistant" &&
                            message.content.contains { $0.text == "completed from lifecycle" }
                    }
            }
        }
    }

    @Test func `pending run blocks second main send`() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId, messages: [])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "first")
        try await waitUntil("first send becomes pending") {
            await MainActor.run { vm.pendingRunCount == 1 && !vm.isSending }
        }
        let firstRunIds = await transport.sentRunIds()
        #expect(firstRunIds.count == 1)
        #expect(await MainActor.run { !vm.canSend })

        await MainActor.run {
            vm.input = "second"
            vm.send()
        }
        try await Task.sleep(for: .milliseconds(50))

        #expect(await transport.sentRunIds() == firstRunIds)
        #expect(await MainActor.run { vm.pendingRunCount } == 1)
        #expect(await MainActor.run { vm.input } == "second")
    }

    @Test func `terminal ok send ack clears pending run without waiting for completion`() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId, messages: [])
        let (transport, vm) = await makeViewModel(historyResponses: [history, history])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "cached")
        try await waitUntil("terminal ok ack clears pending run") {
            await MainActor.run { vm.pendingRunCount == 0 && !vm.isSending }
        }

        #expect(await MainActor.run { vm.errorText } == nil)
        #expect(await transport.waitCompletionRunIds().isEmpty)
        #expect(await MainActor.run { vm.messages.containsUserText("cached") })
    }

    @Test func `rekeys optimistic user message when gateway reuses active run`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let (_, vm) = await makeViewModel(
            historyResponses: [historyPayload(sessionId: sessionId)],
            historyResponseHook: { _, index, _ in
                guard index == 1 else { return nil }
                return historyPayload(
                    sessionId: sessionId,
                    messages: [
                        chatTextMessage(
                            role: "user",
                            text: "same active request",
                            timestamp: now + 5000,
                            idempotencyKey: "\(remoteRunId):user"),
                    ])
            },
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }
        await responseGate.open()

        try await waitUntil("reused run adopts one canonical user row") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" }) == 1 &&
                    vm.messages.contains(where: { message in
                        message.id == optimisticID &&
                            message.timestamp == now + 5000 &&
                            message.idempotencyKey == "\(remoteRunId):user"
                    })
            }
        }
    }

    @Test func `reused run preserves canonical event received before acknowledgement`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionId: sessionId),
                historyPayload(sessionId: sessionId, messages: []),
            ],
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }
        let canonicalTimestamp = now + 5000
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "canonical active request",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: canonicalTimestamp,
                        idempotencyKey: "\(remoteRunId):user"),
                    messageId: "srv-reused-run-user",
                    messageSeq: 1)))
        try await waitUntil("canonical event arrives before send acknowledgement") {
            await MainActor.run { vm.messages.count(where: { $0.role == "user" }) == 2 }
        }
        await responseGate.open()

        try await waitUntil("reused run preserves canonical event data") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" }) == 1 &&
                    vm.messages.contains(where: { message in
                        message.id == optimisticID &&
                            message.content.first?.text == "canonical active request" &&
                            message.timestamp == canonicalTimestamp &&
                            message.idempotencyKey == "\(remoteRunId):user"
                    })
            }
        }
    }

    @Test func `reused run final stays scoped to surviving canonical user turn`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let activeUser = chatTextMessage(
            role: "user",
            text: "same active request",
            timestamp: now + 1,
            idempotencyKey: "\(remoteRunId):user")
        let activeReply = chatTextMessage(
            role: "assistant",
            text: "active reply",
            timestamp: now + 2,
            idempotencyKey: remoteRunId)
        let newerUser = chatTextMessage(
            role: "user",
            text: "newer request from another client",
            timestamp: now + 3,
            idempotencyKey: "other-client-run:user")
        let initialHistory = historyPayload(sessionId: sessionId, messages: [activeUser])
        let canonicalHistory = historyPayload(
            sessionId: sessionId,
            messages: [activeUser, activeReply, newerUser])
        let responseGate = AsyncGate()
        let (transport, vm) = await makeViewModel(
            historyResponses: [initialHistory, canonicalHistory, canonicalHistory],
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "assistant",
                        text: "active reply",
                        timestamp: now + 2,
                        idempotencyKey: remoteRunId),
                    messageId: "srv-active-reply",
                    messageSeq: 2)))
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "user",
                        text: "newer request from another client",
                        timestamp: now + 3,
                        idempotencyKey: "other-client-run:user"),
                    messageId: "srv-newer-user",
                    messageSeq: 3)))
        try await waitUntil("newer user arrives before reused-run acknowledgement") {
            await MainActor.run { vm.messages.containsUserText("newer request from another client") }
        }
        await responseGate.open()
        try await waitUntil("reused run collapses onto earlier canonical user") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" && $0.content.first?.text == "same active request" }) == 1
            }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: activeReply,
                    errorMessage: nil)))

        try await waitUntil("reused final does not duplicate earlier canonical reply") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages
                    .count(where: { $0.role == "assistant" && $0.content.first?.text == "active reply" }) == 1
            }
        }
    }

    @Test func `newer identical reply does not suppress reused run final`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let history = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same active request",
                    timestamp: now - 3000,
                    idempotencyKey: "\(remoteRunId):user"),
                chatTextMessage(
                    role: "user",
                    text: "newer request from another client",
                    timestamp: now - 2000,
                    idempotencyKey: "other-client-run:user"),
                chatTextMessage(
                    role: "assistant",
                    text: "OK",
                    timestamp: now - 1000),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 3 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        try await waitUntil("duplicate request is optimistic") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" && $0.content.first?.text == "same active request" }) == 2
            }
        }
        await responseGate.open()
        try await waitUntil("duplicate request collapses onto older active user") {
            guard await historyCount.current() >= 2 else { return false }
            return await MainActor.run {
                vm.messages.count(where: {
                    $0.role == "user" && $0.content.first?.text == "same active request"
                }) == 1
            }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "OK",
                        timestamp: now + 4,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))

        try await waitUntil("reused final remains distinct from newer turn reply") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.count(where: { $0.role == "assistant" && $0.content.first?.text == "OK" }) == 2
            }
        }
        await finalRefreshGate.release()
    }

    @Test func `correlated reply after metadata free steering suppresses reused final duplicate`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let history = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same active request",
                    timestamp: now - 3000,
                    idempotencyKey: "\(remoteRunId):user"),
                chatTextMessage(
                    role: "user",
                    text: "steer the active run",
                    timestamp: now - 2000),
                chatTextMessage(
                    role: "assistant",
                    text: "steered reply",
                    timestamp: now - 1000,
                    idempotencyKey: remoteRunId),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        try await waitUntil("steered duplicate request is optimistic") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" && $0.content.first?.text == "same active request" }) == 2
            }
        }
        await responseGate.open()
        try await waitUntil("steered duplicate request collapses onto active user") {
            await MainActor.run {
                vm.messages.count(where: {
                    $0.role == "user" && $0.content.first?.text == "same active request"
                }) == 1
            }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "steered reply",
                        timestamp: now + 1,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))

        try await waitUntil("steering row remains inside reused run scope") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.count(where: {
                        $0.role == "assistant" && $0.content.first?.text == "steered reply"
                    }) == 1
            }
        }
    }

    @Test func `canonical projected reply after steering adopts reused provisional final`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let history = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same active request",
                    timestamp: now - 1000,
                    idempotencyKey: "\(remoteRunId):user"),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 3 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageHook: { _ in
                OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        try await waitUntil("steering adoption send refresh completes") {
            await historyCount.current() >= 2
        }
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "steered reply",
                        timestamp: now + 1,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))
        try await waitUntil("provisional reply precedes steering row") {
            await MainActor.run {
                vm.messages.contains { $0.role == "assistant" && $0.content.first?.text == "steered reply" }
            }
        }
        let provisionalID = try await MainActor.run {
            try #require(vm.messages.first(where: {
                $0.role == "assistant" && $0.content.first?.text == "steered reply"
            })?.id)
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "user",
                        text: "steer the active run",
                        timestamp: now + 2),
                    messageId: "srv-steering-user",
                    messageSeq: 2)))
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "assistant",
                        text: "canonical steered reply",
                        timestamp: now + 3,
                        idempotencyKey: remoteRunId),
                    messageId: "srv-steered-reply",
                    messageSeq: 3)))

        try await waitUntil("canonical reply after steering adopts provisional row") {
            await MainActor.run {
                guard vm.messages.count(where: { $0.role == "assistant" }) == 1,
                      let reply = vm.messages.first(where: { $0.id == provisionalID }),
                      reply.content.first?.text == "canonical steered reply",
                      reply.timestamp == now + 3,
                      let steeringIndex = vm.messages.firstIndex(where: {
                          $0.role == "user" && $0.content.first?.text == "steer the active run"
                      }),
                      let replyIndex = vm.messages.firstIndex(where: { $0.id == provisionalID })
                else {
                    return false
                }
                return steeringIndex < replyIndex
            }
        }
        await finalRefreshGate.release()
    }

    @Test func `metadata free channel turn does not adopt reused provisional final`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let history = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same active request",
                    timestamp: now - 1000,
                    idempotencyKey: "\(remoteRunId):user"),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 3 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageHook: { _ in
                OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        try await waitUntil("channel boundary send refresh completes") {
            await historyCount.current() >= 2
        }
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "same reply",
                        timestamp: now + 1,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))
        try await waitUntil("reused provisional reply is visible") {
            await MainActor.run {
                vm.messages.contains { $0.role == "assistant" && $0.content.first?.text == "same reply" }
            }
        }
        let provisionalID = try await MainActor.run {
            try #require(vm.messages.first(where: {
                $0.role == "assistant" && $0.content.first?.text == "same reply"
            })?.id)
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "user",
                        text: "independent channel request",
                        timestamp: now + 2),
                    messageId: "srv-channel-user",
                    messageSeq: 2)))
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "assistant",
                        text: "same reply",
                        timestamp: now + 3),
                    messageId: "srv-channel-reply",
                    messageSeq: 3)))

        try await waitUntil("independent channel reply remains distinct") {
            await MainActor.run {
                let replies = vm.messages.filter {
                    $0.role == "assistant" && $0.content.first?.text == "same reply"
                }
                guard replies.count == 2, replies.first?.id == provisionalID else { return false }
                guard let userIndex = vm.messages.firstIndex(where: {
                    $0.role == "user" && $0.content.first?.text == "independent channel request"
                }),
                    let canonicalIndex = vm.messages.firstIndex(where: { $0.id == replies[1].id })
                else {
                    return false
                }
                return userIndex < canonicalIndex
            }
        }
        await finalRefreshGate.release()
    }

    @Test func `late transformed canonical user keeps reused run final scope`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let finalRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let emptyHistory = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [emptyHistory, emptyHistory],
            requestHistoryHook: { _ in
                let count = await historyCount.increment()
                if count == 3 {
                    await finalRefreshGate.wait()
                }
            },
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        await responseGate.open()
        try await waitUntil("optimistic user adopts reused run identity") {
            await MainActor.run {
                vm.messages.contains(where: { message in
                    message.role == "user" && message.idempotencyKey == "\(remoteRunId):user"
                })
            }
        }
        try await waitUntil("post-ack history refresh completes") {
            await historyCount.current() >= 2
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "user",
                        text: "canonical redacted request",
                        timestamp: now + 1,
                        idempotencyKey: "\(remoteRunId):user"),
                    messageId: "srv-transformed-user",
                    messageSeq: 1)))
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "assistant",
                        text: "active reply",
                        timestamp: now + 2,
                        idempotencyKey: remoteRunId),
                    messageId: "srv-active-reply",
                    messageSeq: 2)))
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "user",
                        text: "newer request from another client",
                        timestamp: now + 3,
                        idempotencyKey: "other-client-run:user"),
                    messageId: "srv-newer-user",
                    messageSeq: 3)))
        try await waitUntil("canonical user transformation and newer turn arrive") {
            await MainActor.run {
                vm.messages.containsUserText("canonical redacted request") &&
                    vm.messages.containsUserText("newer request from another client")
            }
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "active reply",
                        timestamp: now + 4,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))

        try await waitUntil("late canonical adoption does not duplicate reused final") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages
                    .count(where: { $0.role == "assistant" && $0.content.first?.text == "active reply" }) == 1
            }
        }
        await finalRefreshGate.release()
    }

    @Test func `history reconciled early final stays in canonical order after delayed event`() async throws {
        let sessionId = "sess-main"
        let remoteRunId = "existing-active-run"
        let now = Date().timeIntervalSince1970 * 1000
        let responseGate = AsyncGate()
        let historyGate = AsyncGate()
        let emptyHistory = historyPayload(sessionId: sessionId)
        let canonicalHistory = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "user",
                    text: "same active request",
                    timestamp: now,
                    idempotencyKey: "\(remoteRunId):user"),
                chatTextMessage(
                    role: "assistant",
                    text: "early final reply",
                    timestamp: now + 2,
                    idempotencyKey: remoteRunId),
                chatTextMessage(
                    role: "user",
                    text: "newer channel request",
                    timestamp: now + 3),
            ])
        let (transport, vm) = await makeViewModel(
            historyResponses: [emptyHistory, canonicalHistory],
            historyResponseHook: { _, index, _ in
                guard index == 1 else { return nil }
                await historyGate.wait()
                return canonicalHistory
            },
            sendMessageHook: { _ in
                await responseGate.wait()
                return OpenClawChatSendResponse(runId: remoteRunId, status: "in_flight")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "same active request")
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: remoteRunId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "early final reply",
                        timestamp: now + 1,
                        idempotencyKey: remoteRunId),
                    errorMessage: nil)))
        try await waitUntil("early final is visible before acknowledgement") {
            await MainActor.run {
                vm.messages.contains {
                    $0.role == "assistant" && $0.content.first?.text == "early final reply"
                }
            }
        }
        let provisionalID = try await MainActor.run {
            try #require(vm.messages.first(where: {
                $0.role == "assistant" && $0.content.first?.text == "early final reply"
            })?.id)
        }

        await historyGate.open()
        try await waitUntil("history adopts early final before newer user") {
            await MainActor.run {
                guard let replyIndex = vm.messages.firstIndex(where: { $0.id == provisionalID }),
                      let newerUserIndex = vm.messages.firstIndex(where: {
                          $0.role == "user" && $0.content.first?.text == "newer channel request"
                      })
                else {
                    return false
                }
                return replyIndex < newerUserIndex && vm.messages[replyIndex].timestamp == now + 2
            }
        }

        await responseGate.open()
        try await waitUntil("early final run acknowledgement rekeys optimistic user") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.count(where: {
                        $0.role == "user" && $0.idempotencyKey == "\(remoteRunId):user"
                    }) == 1
            }
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: chatTextModelMessage(
                        role: "assistant",
                        text: "early final reply",
                        timestamp: now + 4,
                        idempotencyKey: remoteRunId),
                    messageId: "srv-early-final-reply",
                    messageSeq: 2)))

        try await waitUntil("delayed canonical event preserves history order") {
            await MainActor.run {
                guard vm.messages.count(where: {
                    $0.role == "assistant" && $0.idempotencyKey == remoteRunId
                }) == 1,
                    let replyIndex = vm.messages.firstIndex(where: { $0.id == provisionalID }),
                    let newerUserIndex = vm.messages.firstIndex(where: {
                        $0.role == "user" && $0.content.first?.text == "newer channel request"
                    })
                else {
                    return false
                }
                return replyIndex < newerUserIndex && vm.messages[replyIndex].timestamp == now + 2
            }
        }
    }

    @Test func `terminal timeout send ack surfaces error and allows next send`() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId, messages: [])
        let sendCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sendMessageHook: { runId in
                let count = await sendCount.increment()
                return OpenClawChatSendResponse(
                    runId: runId,
                    status: count == 1 ? "timeout" : "ok")
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm, text: "first")
        try await waitUntil("timeout ack clears pending run") {
            await MainActor.run { vm.pendingRunCount == 0 && !vm.isSending }
        }
        #expect(await transport.sentRunIds().count == 1)
        #expect(await MainActor.run { vm.errorText } == "Chat failed before the run started; try again.")
        #expect(await MainActor.run { !vm.messages.containsUserText("first") })

        await sendUserMessage(vm, text: "second")
        try await waitUntil("second send is accepted after timeout ack") {
            await transport.sentRunIds().count == 2
        }
    }

    @Test func `keeps optimistic user message when final refresh returns only assistant history`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload(sessionId: sessionId)
        let history2 = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "final answer",
                    timestamp: now + 1),
            ])

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        try await sendMessageAndEmitFinal(
            transport: transport,
            vm: vm,
            text: "hello from mac webchat")

        try await waitUntil("assistant history refreshes without dropping user message") {
            await MainActor.run {
                let texts = vm.messages.map { message in
                    (message.role, message.content.compactMap(\.text).joined(separator: "\n"))
                }
                return texts.contains(where: { $0.0 == "assistant" && $0.1 == "final answer" }) &&
                    texts.contains(where: { $0.0 == "user" && $0.1 == "hello from mac webchat" })
            }
        }
    }

    @Test func `keeps optimistic user message when final refresh history is temporarily empty`() async throws {
        let sessionId = "sess-main"
        let history1 = historyPayload(sessionId: sessionId)
        let history2 = historyPayload(sessionId: sessionId, messages: [])

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        try await sendMessageAndEmitFinal(
            transport: transport,
            vm: vm,
            text: "hello from mac webchat")

        try await waitUntil("empty refresh does not clear optimistic user message") {
            await MainActor.run {
                vm.messages.contains { message in
                    message.role == "user" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "hello from mac webchat"
                }
            }
        }
    }

    @Test func `does not duplicate user message when refresh returns canonical timestamp`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let refreshGate = AsyncGate()
        let historyCallCount = AsyncCounter()
        let history1 = historyPayload(
            sessionId: sessionId,
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "earlier answer",
                    timestamp: now + 1000),
            ])
        let (_, vm) = await makeViewModel(
            historyResponses: [history1],
            requestHistoryHook: { _ in
                if await historyCallCount.increment() == 2 {
                    await refreshGate.wait()
                }
            },
            historyResponseHook: { _, index, sentRunIds in
                guard index == 1, let runId = sentRunIds.last else { return nil }
                return historyPayload(
                    sessionId: sessionId,
                    messages: [
                        chatTextMessage(
                            role: "assistant",
                            text: "earlier answer",
                            timestamp: now + 1000),
                        chatTextMessage(
                            role: "user",
                            text: "hello from mac webchat",
                            timestamp: now + 5000,
                            idempotencyKey: "\(runId):user"),
                        chatTextMessage(
                            role: "assistant",
                            text: "final answer",
                            timestamp: now + 6000),
                    ])
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        await sendUserMessage(vm, text: "hello from mac webchat")
        try await waitUntil("canonical refresh starts") { await historyCallCount.current() == 2 }
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }
        await refreshGate.open()

        try await waitUntil("send acknowledgement refresh keeps one user message") {
            await MainActor.run {
                let userMessages = vm.messages.filter { message in
                    message.role == "user" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "hello from mac webchat"
                }
                let hasAssistant = vm.messages.contains { message in
                    message.role == "assistant" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "final answer"
                }
                return hasAssistant && userMessages.count == 1
            }
        }
        #expect(await MainActor.run { vm.messages.last(where: { $0.role == "user" })?.id } == optimisticID)
    }

    @Test func `metadata free canonical refresh keeps ambiguous user turns distinct`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let refreshGate = AsyncGate()
        let historyCallCount = AsyncCounter()
        let (_, vm) = await makeViewModel(
            historyResponses: [historyPayload(sessionId: sessionId)],
            requestHistoryHook: { _ in
                if await historyCallCount.increment() == 2 {
                    await refreshGate.wait()
                }
            },
            historyResponseHook: { _, index, _ in
                guard index == 1 else { return nil }
                return historyPayload(
                    sessionId: sessionId,
                    messages: [
                        chatTextMessage(
                            role: "user",
                            text: "legacy echo",
                            timestamp: now + 5000),
                        chatTextMessage(
                            role: "assistant",
                            text: "legacy answer",
                            timestamp: now + 6000),
                    ])
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        await sendUserMessage(vm, text: "legacy echo")
        try await waitUntil("legacy refresh starts") { await historyCallCount.current() == 2 }
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }
        await refreshGate.open()

        try await waitUntil("metadata free canonical refresh preserves both user rows") {
            await MainActor.run {
                vm.messages.count(where: { message in
                    message.role == "user" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "legacy echo"
                }) == 2 && vm.messages.contains(where: { message in
                    message.role == "assistant" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "legacy answer"
                })
            }
        }
        #expect(await MainActor.run { vm.messages.contains(where: { $0.id == optimisticID }) })
    }

    @Test func `preserves local echo when another client sends identical text during refresh`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload(sessionId: sessionId)],
            historyResponseHook: { _, index, _ in
                guard index == 1 else { return nil }
                return historyPayload(
                    sessionId: sessionId,
                    messages: [
                        chatTextMessage(
                            role: "user",
                            text: "same words",
                            timestamp: now + 5000,
                            idempotencyKey: "other-client:user"),
                        chatTextMessage(
                            role: "assistant",
                            text: "other client's answer",
                            timestamp: now + 6000),
                    ])
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        await sendUserMessage(vm, text: "same words")

        try await waitUntil("foreign identical turn and local echo both survive") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.count(where: { message in
                        message.role == "user" &&
                            message.content.compactMap(\.text).joined(separator: "\n") == "same words"
                    }) == 2
            }
        }
        #expect(await transport.sentRunIds().count == 1)
    }

    @Test func `preserves repeated optimistic user messages with identical content during refresh`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history1],
            historyResponseHook: { _, index, sentRunIds in
                guard index > 0, let firstRunId = sentRunIds.first else { return nil }
                return historyPayload(
                    sessionId: sessionId,
                    messages: [
                        chatTextMessage(
                            role: "user",
                            text: "retry",
                            timestamp: now + 5000,
                            idempotencyKey: "\(firstRunId):user"),
                        chatTextMessage(
                            role: "assistant",
                            text: "first answer",
                            timestamp: now + 6000),
                    ])
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        try await sendMessageAndEmitFinal(
            transport: transport,
            vm: vm,
            text: "retry")
        try await waitUntil("first retry completes") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.role == "assistant" &&
                            message.content.compactMap(\.text).joined(separator: "\n") == "first answer"
                    }
            }
        }
        try await sendMessageAndEmitFinal(
            transport: transport,
            vm: vm,
            text: "retry")

        try await waitUntil("repeated optimistic user message is preserved") {
            await MainActor.run {
                let retryMessages = vm.messages.filter { message in
                    message.role == "user" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "retry"
                }
                let hasAssistant = vm.messages.contains { message in
                    message.role == "assistant" &&
                        message.content.compactMap(\.text).joined(separator: "\n") == "first answer"
                }
                return hasAssistant && retryMessages.count == 2
            }
        }
    }

    @Test func `run refresh does not resurrect old user turns omitted by bounded history`() async throws {
        let sessionId = "sess-main"
        let now = Date().timeIntervalSince1970 * 1000
        let oldMessages = [
            chatTextMessage(role: "user", text: "old question", timestamp: now - 2000),
            chatTextMessage(role: "assistant", text: "old answer", timestamp: now - 1000),
        ]
        let boundedRefreshMessages = [
            chatTextMessage(role: "user", text: "current question", timestamp: now + 5000),
            chatTextMessage(role: "assistant", text: "current answer", timestamp: now + 6000),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionId: sessionId, messages: oldMessages),
                historyPayload(sessionId: sessionId, messages: boundedRefreshMessages),
            ])
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)
        try await sendMessageAndEmitFinal(
            transport: transport,
            vm: vm,
            text: "current question")

        try await waitUntil("bounded refresh replaces old history") {
            await MainActor.run {
                let texts = vm.messages.map { message in
                    message.content.compactMap(\.text).joined(separator: "\n")
                }
                return texts.contains("current answer") &&
                    !texts.contains("old question") &&
                    !texts.contains("old answer")
            }
        }
    }

    @Test @MainActor func `bounded repeated same text reply invalidates older stale refresh`() async throws {
        let sessionId = "sess-main"
        let staleRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let staleRefreshReleasedCount = AsyncCounter()
        let now = (Date().timeIntervalSince1970 * 1000) + 10000
        let firstTurn = [
            chatTextMessage(role: "user", text: "retry", timestamp: now),
            chatTextMessage(role: "assistant", text: "first answer", timestamp: now + 1),
        ]
        let latestBoundedTurn = [
            chatTextMessage(role: "user", text: "retry", timestamp: now + 2),
            chatTextMessage(role: "assistant", text: "second answer", timestamp: now + 3),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionId: sessionId, messages: firstTurn),
                historyPayload(sessionId: sessionId, messages: firstTurn),
                historyPayload(sessionId: sessionId, messages: latestBoundedTurn),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await historyCount.increment()
                if count == 2 {
                    await staleRefreshGate.wait()
                    _ = await staleRefreshReleasedCount.increment()
                }
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        transport.emit(OpenClawChatTransportEvent.seqGap)
        try await waitUntil("stale refresh is in flight") {
            await historyCount.current() == 2
        }

        vm.input = "retry"
        vm.send()
        _ = try await waitForLastSentRunId(transport)
        try await waitUntil("bounded second answer applies") {
            await MainActor.run {
                vm.sessionId == sessionId &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "second answer" }
                    }
            }
        }

        await staleRefreshGate.release()
        try await waitUntil("stale refresh resumes") {
            await staleRefreshReleasedCount.current() == 1
        }

        #expect(await MainActor.run {
            vm.messages.contains { message in
                message.content.contains { $0.text == "second answer" }
            }
        })
    }

    @Test @MainActor func `transformed canonical reply invalidates older stale refresh`() async throws {
        let staleRefreshGate = SessionSubscribeGate()
        let historyCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let staleTurn = [
            chatTextMessage(role: "user", text: "older question", timestamp: now - 2),
            chatTextMessage(role: "assistant", text: "older answer", timestamp: now - 1),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionId: "sess-bootstrap", messages: staleTurn),
                historyPayload(sessionId: "sess-stale", messages: staleTurn),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await historyCount.increment()
                if count == 2 {
                    await staleRefreshGate.wait()
                }
            },
            historyResponseHook: { _, index, sentRunIds in
                guard index == 2, let runId = sentRunIds.first else { return nil }
                return historyPayload(
                    sessionId: "sess-canonical",
                    messages: [
                        chatTextMessage(
                            role: "user",
                            text: "canonical redacted request",
                            timestamp: now,
                            idempotencyKey: "\(runId):user"),
                        chatTextMessage(
                            role: "assistant",
                            text: "canonical answer",
                            timestamp: now + 1,
                            idempotencyKey: runId),
                    ])
            })
        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-bootstrap")

        transport.emit(OpenClawChatTransportEvent.seqGap)
        try await waitUntil("stale transformed refresh is in flight") {
            await historyCount.current() == 2
        }

        vm.input = "original request"
        vm.send()
        _ = try await waitForLastSentRunId(transport)
        try await waitUntil("transformed canonical answer applies") {
            await MainActor.run {
                vm.sessionId == "sess-canonical" &&
                    vm.messages.containsUserText("canonical redacted request") &&
                    vm.messages.contains { $0.content.contains { $0.text == "canonical answer" } }
            }
        }

        let healthCallsBeforeRelease = await transport.healthCallCount()
        await staleRefreshGate.release()
        try await waitUntil("older transformed refresh completes") {
            await transport.healthCallCount() > healthCallsBeforeRelease
        }

        #expect(vm.sessionId == "sess-canonical")
        #expect(vm.messages.containsUserText("canonical redacted request"))
        #expect(vm.messages.contains { $0.content.contains { $0.text == "canonical answer" } })
    }

    @Test func `accepts canonical session key events for own pending run`() async throws {
        let history1 = historyPayload()
        let history2 = historyPayload(
            messages: [
                chatTextMessage(
                    role: "assistant",
                    text: "from history",
                    timestamp: Date().timeIntervalSince1970 * 1000),
            ])

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm)
        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        let runId = try await waitForLastSentRunId(transport)
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

    @Test func `surfaces assistant error message after own run refresh`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload()
        let history2 = historyPayload(
            messages: [
                chatErrorMessage(
                    role: "assistant",
                    errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~28 min.",
                    timestamp: now),
            ])

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm)

        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        let runId = try await waitForLastSentRunId(transport)
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "error",
                    message: nil,
                    errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~28 min.")))

        try await waitUntil("pending run clears after error") {
            await MainActor.run { vm.pendingRunCount == 0 }
        }
        try await waitUntil("history refresh shows assistant error message") {
            await MainActor.run {
                vm.messages.contains(where: { message in
                    message.role == "assistant" &&
                        OpenClawChatMessage.displayText(
                            contentText: message.content.compactMap(\.text).joined(separator: "\n"),
                            role: message.role,
                            stopReason: message.stopReason,
                            errorMessage: message.errorMessage)
                        .contains("You have hit your ChatGPT usage limit")
                })
            }
        }
    }

    @Test func `accepts canonical session key events for external runs`() async throws {
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

    @Test func `appends external session user message for active session`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            sessionKey: "agent:aiden:main",
            historyResponses: [historyPayload(sessionKey: "agent:aiden:main")])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:aiden:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "spoken transcript",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now),
                    messageId: "msg-1",
                    messageSeq: 1)))

        try await waitUntil("external transcript visible") {
            await MainActor.run {
                vm.messages.count == 1 &&
                    vm.messages.first?.role == "user" &&
                    vm.messages.first?.content.first?.text == "spoken transcript"
            }
        }
    }

    @Test func `appends global session user message for selected agent`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            sessionKey: "agent:work:global",
            historyResponses: [historyPayload(sessionKey: "agent:work:global")])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "global",
                    agentId: "work",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "global transcript",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now),
                    messageId: "msg-global-work",
                    messageSeq: 1)))

        try await waitUntil("selected agent global transcript visible") {
            await MainActor.run {
                vm.messages.count == 1 &&
                    vm.messages.first?.role == "user" &&
                    vm.messages.first?.content.first?.text == "global transcript"
            }
        }
    }

    @Test func `ignores global session user message for different agent`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            sessionKey: "agent:work:global",
            historyResponses: [historyPayload(sessionKey: "agent:work:global")])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "global",
                    agentId: "main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "wrong global transcript",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now),
                    messageId: "msg-global-main",
                    messageSeq: 1)))

        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await MainActor.run { vm.messages.isEmpty })
    }

    @Test func `ignores agent main session message for different current main alias`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(historyResponses: [historyPayload()])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:sentinel:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "wrong agent transcript",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now),
                    messageId: "msg-other-agent",
                    messageSeq: 1)))

        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await MainActor.run { vm.messages.isEmpty })
    }

    @Test func `appends external session assistant message while run pending`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            sendMessageStatus: "pending")

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        await sendUserMessage(vm, text: "ping")
        try await waitUntil("local run pending") { await MainActor.run { vm.pendingRunCount == 1 } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "assistant",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "agent reply",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now + 1),
                    messageId: "msg-assistant-1",
                    messageSeq: 2)))

        try await waitUntil("assistant transcript visible while pending") {
            await MainActor.run {
                vm.messages.contains(where: { msg in
                    msg.role == "assistant" &&
                        msg.content.first?.text == "agent reply"
                })
            }
        }
    }

    @Test func `dedupes gateway echo of local user message`() async throws {
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            sendMessageHook: { runId in
                OpenClawChatSendResponse(runId: runId, status: "pending")
            })

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        await sendUserMessage(vm, text: "echo me")
        let runId = try await waitForLastSentRunId(transport)
        try await waitUntil("optimistic user message visible") {
            await MainActor.run {
                vm.messages.count == 1 && vm.messages.first?.content.first?.text == "echo me"
            }
        }

        // Gateway echoes the same user turn over the session-message stream with a
        // server-assigned timestamp that differs from the optimistic local one.
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "echo me",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: Date().timeIntervalSince1970 * 1000 + 5000,
                        idempotencyKey: "\(runId):user"),
                    messageId: "srv-echo-1",
                    messageSeq: 1)))

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await MainActor.run {
            vm.messages.count(where: { msg in
                msg.role == "user" && msg.content.first?.text == "echo me"
            }) == 1
        })
    }

    @Test func `late correlated user echo replaces optimistic row after final`() async throws {
        let history = historyPayload()
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageStatus: "pending")

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        await sendUserMessage(vm, text: "sensitive draft")
        let runId = try await waitForLastSentRunId(transport)
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))
        try await waitUntil("final clears pending correlation bookkeeping") {
            await MainActor.run { vm.pendingRunCount == 0 }
        }

        let canonicalTimestamp = Date().timeIntervalSince1970 * 1000 + 5000
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "redacted canonical text",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: canonicalTimestamp,
                        idempotencyKey: "\(runId):user"),
                    messageId: "srv-late-user-echo",
                    messageSeq: 2)))

        try await waitUntil("late canonical echo replaces optimistic row") {
            await MainActor.run {
                vm.messages.count(where: { $0.role == "user" }) == 1 &&
                    vm.messages.contains(where: { message in
                        message.id == optimisticID &&
                            message.content.first?.text == "redacted canonical text" &&
                            message.timestamp == canonicalTimestamp
                    })
            }
        }
    }

    @Test func `metadata free same text event cannot consume pending local identity`() async throws {
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            sendMessageStatus: "pending")

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        await sendUserMessage(vm, text: "legacy echo")
        let runId = try await waitForLastSentRunId(transport)
        let optimisticID = try await MainActor.run {
            try #require(vm.messages.last(where: { $0.role == "user" })?.id)
        }
        let canonicalTimestamp = Date().timeIntervalSince1970 * 1000 + 5000

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "legacy echo",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: canonicalTimestamp),
                    messageId: "srv-legacy-echo-1",
                    messageSeq: 1)))

        try await waitUntil("ambiguous metadata free event remains distinct") {
            await MainActor.run {
                vm.messages.count(where: { message in
                    message.role == "user" && message.content.first?.text == "legacy echo"
                }) == 2
            }
        }

        let localCanonicalTimestamp = canonicalTimestamp + 1000
        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "legacy echo",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: localCanonicalTimestamp,
                        idempotencyKey: "\(runId):user"),
                    messageId: "srv-local-echo-1",
                    messageSeq: 2)))

        try await waitUntil("later correlated local echo adopts only the optimistic row") {
            await MainActor.run {
                vm.messages.count(where: { message in
                    message.role == "user" && message.content.first?.text == "legacy echo"
                }) == 2 && vm.messages.contains(where: { message in
                    message.id == optimisticID &&
                        message.timestamp == localCanonicalTimestamp &&
                        message.idempotencyKey == "\(runId):user"
                }) && vm.messages.contains(where: { message in
                    message.timestamp == canonicalTimestamp && message.idempotencyKey == nil
                })
            }
        }
    }

    @Test func `appends same content user transcript when it is not local echo`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(messages: [
                    chatTextMessage(role: "user", text: "repeat", timestamp: now),
                ]),
            ])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") {
            await MainActor.run { vm.messages.count == 1 }
        }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "agent:main:main",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "repeat",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now + 1000),
                    messageId: "msg-repeat-2",
                    messageSeq: 2)))

        try await waitUntil("repeated user transcript appended") {
            await MainActor.run {
                vm.messages.count(where: { msg in
                    msg.role == "user" && msg.content.first?.text == "repeat"
                }) == 2
            }
        }
    }

    @Test func `ignores external session user message for other session`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(historyResponses: [historyPayload()])

        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history loaded") { await MainActor.run { vm.messages.isEmpty } }

        transport.emit(
            .sessionMessage(
                OpenClawSessionMessageEventPayload(
                    sessionKey: "other",
                    message: OpenClawChatMessage(
                        role: "user",
                        content: [
                            OpenClawChatMessageContent(
                                type: "text",
                                text: "other transcript",
                                mimeType: nil,
                                fileName: nil,
                                content: nil),
                        ],
                        timestamp: now),
                    messageId: "msg-2",
                    messageSeq: 2)))

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await MainActor.run { vm.messages.isEmpty })
    }

    @Test func `preserves message I ds across history refreshes`() async throws {
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

    @Test func `clears streaming on external final event`() async throws {
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

    @Test func `seq gap clears pending runs and auto refreshes history`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history1 = historyPayload()
        let history2 = historyPayload(messages: [chatTextMessage(
            role: "assistant",
            text: "resynced after gap",
            timestamp: now)])

        let (transport, vm) = await makeViewModel(
            historyResponses: [history1, history2],
            sendMessageStatus: "pending")

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

    @Test func `session choices prefer main and recent`() async throws {
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

    @Test func `session choices include current when missing`() async throws {
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

    @Test func `session choices use resolved main session key instead of literal main`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let recent = now - (30 * 60 * 1000)
        let recentOlder = now - (90 * 60 * 1000)
        let history = historyPayload(sessionKey: "Luke’s MacBook Pro", sessionId: "sess-main")
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 2,
            defaults: OpenClawChatSessionsDefaults(
                model: nil,
                contextTokens: nil,
                mainSessionKey: "Luke’s MacBook Pro"),
            sessions: [
                OpenClawChatSessionEntry(
                    key: "Luke’s MacBook Pro",
                    kind: nil,
                    displayName: "Luke’s MacBook Pro",
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
                    modelProvider: nil,
                    model: nil,
                    contextTokens: nil),
                sessionEntry(key: "recent-1", updatedAt: recentOlder),
            ])

        let (_, vm) = await makeViewModel(
            sessionKey: "Luke’s MacBook Pro",
            historyResponses: [history],
            sessionsResponses: [sessions])
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["Luke’s MacBook Pro", "recent-1"])
    }

    @Test func `session choices hide internal onboarding session`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let recent = now - (2 * 60 * 1000)
        let recentOlder = now - (5 * 60 * 1000)
        let history = historyPayload(sessionKey: "agent:main:main", sessionId: "sess-main")
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 2,
            defaults: OpenClawChatSessionsDefaults(
                model: nil,
                contextTokens: nil,
                mainSessionKey: "agent:main:main"),
            sessions: [
                OpenClawChatSessionEntry(
                    key: "agent:main:onboarding",
                    kind: nil,
                    displayName: "Luke’s MacBook Pro",
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
                    modelProvider: nil,
                    model: nil,
                    contextTokens: nil),
                OpenClawChatSessionEntry(
                    key: "agent:main:main",
                    kind: nil,
                    displayName: "Luke’s MacBook Pro",
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
                    modelProvider: nil,
                    model: nil,
                    contextTokens: nil),
            ])

        let (_, vm) = await makeViewModel(
            sessionKey: "agent:main:main",
            historyResponses: [history],
            sessionsResponses: [sessions])
        await MainActor.run { vm.load() }
        try await waitUntil("sessions loaded") { await MainActor.run { !vm.sessions.isEmpty } }

        let keys = await MainActor.run { vm.sessionChoices.map(\.key) }
        #expect(keys == ["agent:main:main"])
    }

    @Test func `new trigger starts fresh agent session without admin reset`() async throws {
        let before = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "before new", timestamp: 1),
            ])
        let after = historyPayload(sessionKey: "agent:aiden:ios-new", sessionId: nil, messages: [])
        let sessions = OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                model: nil,
                contextTokens: nil,
                mainSessionKey: "agent:aiden:main"),
            sessions: [
                sessionEntry(key: "agent:aiden:main", updatedAt: 1),
            ])

        let (transport, vm) = await makeViewModel(
            historyResponses: [before, after],
            sessionsResponses: [sessions])
        try await loadAndWaitBootstrap(vm: vm)
        try await waitUntil("initial history loaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "before new" }
        }

        await MainActor.run {
            vm.input = "/new"
            vm.send()
        }

        try await waitUntil("fresh agent session selected") {
            await MainActor.run { vm.sessionKey.hasPrefix("agent:aiden:ios-") && vm.messages.isEmpty }
        }
        let createdKeys = await transport.createdSessionKeys()
        #expect(createdKeys.count == 1)
        #expect(createdKeys.first?.hasPrefix("agent:aiden:ios-") == true)
        #expect(await transport.createdParentSessionKeys() == ["main"])
        #expect(await transport.resetSessionKeys().isEmpty)
        #expect(await transport.lastSentRunId() == nil)

        await sendUserMessage(vm, text: "hello fresh session")
        try await waitUntil("send uses fresh session") {
            let key = await transport.lastSentSessionKey()
            return key?.hasPrefix("agent:aiden:ios-") == true
        }
    }

    @Test func `new trigger falls back to reset when create session is unsupported`() async throws {
        let before = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "before new", timestamp: 1),
            ])
        let after = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "after reset fallback", timestamp: 2),
            ])
        let unsupported = NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.create not supported by this transport"])

        let (transport, vm) = await makeViewModel(
            historyResponses: [before, after],
            createSessionHook: { _, _ in throw unsupported })
        try await loadAndWaitBootstrap(vm: vm)
        try await waitUntil("initial history loaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "before new" }
        }

        await MainActor.run {
            vm.input = "/new"
            vm.send()
        }

        try await waitUntil("reset fallback called") {
            await transport.resetSessionKeys() == ["main"]
        }
        try await waitUntil("history reloaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "after reset fallback" }
        }
        #expect(await transport.createdSessionKeys().isEmpty)
        #expect(await MainActor.run { vm.sessionKey } == "main")
        #expect(await MainActor.run { vm.errorText } == nil)
        #expect(await transport.lastSentRunId() == nil)
    }

    @Test func `send attempts request when cached health is stale false`() async throws {
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            healthResponses: [false])
        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap records stale health") {
            await MainActor.run { vm.sessionId == "sess-main" && !vm.healthOK }
        }

        await sendUserMessage(vm, text: "hello despite stale health")

        try await waitUntil("send reaches transport") {
            await transport.lastSentSessionKey() == "main"
        }
        #expect(await MainActor.run { vm.errorText } == nil)
    }

    @Test func `reset trigger resets session and reloads history`() async throws {
        let before = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "before reset", timestamp: 1),
            ])
        let after = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "after reset", timestamp: 2),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [before, after])
        try await loadAndWaitBootstrap(vm: vm)
        try await waitUntil("initial history loaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "before reset" }
        }

        await MainActor.run {
            vm.input = "/reset"
            vm.send()
        }

        try await waitUntil("reset called") {
            await transport.resetSessionKeys() == ["main"]
        }
        try await waitUntil("history reloaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "after reset" }
        }
        #expect(await transport.lastSentRunId() == nil)
    }

    @Test func `compact trigger compacts session and reloads history`() async throws {
        let before = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "before compact", timestamp: 1),
            ])
        let after = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "after compact", timestamp: 2),
            ])

        let (transport, vm) = await makeViewModel(historyResponses: [before, after])
        try await loadAndWaitBootstrap(vm: vm)
        try await waitUntil("initial history loaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "before compact" }
        }

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
        }

        try await waitUntil("compact called") {
            await transport.compactSessionKeys() == ["main"]
        }
        try await waitUntil("history reloaded") {
            await MainActor.run { vm.messages.first?.content.first?.text == "after compact" }
        }
        #expect(await transport.lastSentRunId() == nil)
    }

    @Test func `compact trigger shows generic error message on failure`() async throws {
        let history = historyPayload()
        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            compactSessionHook: { _ in
                throw NSError(
                    domain: "TestCompact",
                    code: 42,
                    userInfo: [NSLocalizedDescriptionKey: "backend details should not leak"])
            })
        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
        }

        try await waitUntil("compact attempted") {
            await transport.compactSessionKeys() == ["main"]
        }
        #expect(await MainActor.run { vm.errorText } == "Unable to compact the session. Please try again.")
    }

    @Test func `compact trigger ignores concurrent and immediate repeat requests`() async throws {
        let before = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "before compact", timestamp: 1),
            ])
        let after = historyPayload(
            messages: [
                chatTextMessage(role: "assistant", text: "after compact", timestamp: 2),
            ])
        let gate = AsyncGate()
        let (transport, vm) = await makeViewModel(
            historyResponses: [before, after],
            compactSessionHook: { _ in
                await gate.wait()
            })
        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
            vm.input = "/compact"
            vm.send()
        }

        try await waitUntil("single compact request issued") {
            await transport.compactSessionKeys() == ["main"]
        }
        #expect(await MainActor.run { vm.errorText } == nil)

        await gate.open()
        try await waitUntil("history reloaded after compact") {
            await MainActor.run { vm.messages.first?.content.first?.text == "after compact" }
        }

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
        }

        try await Task.sleep(for: .milliseconds(50))
        #expect(await transport.compactSessionKeys() == ["main"])
        #expect(await MainActor.run { vm.errorText } == "Please wait before compacting this session again.")
    }

    @Test func `compact trigger allows immediate retry after failure`() async throws {
        let history = historyPayload()
        let attemptCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            compactSessionHook: { _ in
                let next = await attemptCount.increment()
                if next == 1 {
                    throw NSError(
                        domain: "TestCompact",
                        code: 42,
                        userInfo: [NSLocalizedDescriptionKey: "temporary failure"])
                }
            })
        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
        }

        try await waitUntil("first compact attempted") {
            await transport.compactSessionKeys() == ["main"]
        }
        #expect(await MainActor.run { vm.errorText } == "Unable to compact the session. Please try again.")

        await MainActor.run {
            vm.input = "/compact"
            vm.send()
        }

        try await waitUntil("second compact attempted") {
            await transport.compactSessionKeys() == ["main", "main"]
        }
        #expect(await MainActor.run { vm.errorText } == nil)
    }

    @Test func `slash command catalog filters commands and skills`() async throws {
        let commands = [
            commandChoice(
                name: "compact",
                aliases: ["/compact"],
                description: "Compact the session",
                source: .command),
            commandChoice(
                name: "review",
                aliases: ["/review"],
                description: "Review the current change",
                source: .skill,
                acceptsArgs: true),
        ]
        let (_, vm) = await makeViewModel(
            historyResponses: [historyPayload()],
            commandResponses: [commands])

        await MainActor.run { vm.loadSlashCommandsIfNeeded() }
        try await waitUntil("slash commands loaded") {
            await MainActor.run { vm.hasLoadedSlashCommands }
        }

        let allMatches = await MainActor.run {
            vm.slashCommandMatches(query: "/", filter: .all).map(\.name)
        }
        #expect(allMatches == ["compact", "review"])

        let commandMatches = await MainActor.run {
            vm.slashCommandMatches(query: "/co", filter: .commands).map(\.name)
        }
        #expect(commandMatches == ["compact"])

        let skillMatches = await MainActor.run {
            vm.slashCommandMatches(query: "/skill re", filter: .all).map(\.name)
        }
        #expect(skillMatches == ["review"])

        await MainActor.run {
            vm.applySlashCommandSelection(commands[1])
        }
        #expect(await MainActor.run { vm.input } == "/review ")
    }

    @Test func `known slash command sends through chat send`() async throws {
        let commands = [
            commandChoice(
                name: "model",
                aliases: ["/model"],
                description: "Change model",
                source: .command,
                acceptsArgs: true),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload(), historyPayload()],
            commandResponses: [commands])
        try await loadAndWaitBootstrap(vm: vm)

        await sendUserMessage(vm, text: "/model gpt-5")
        _ = try await waitForLastSentRunId(transport)

        #expect(await transport.sentMessages() == ["/model gpt-5"])
    }

    @Test func `slash command catalog loads for current session`() async throws {
        let commands = [
            commandChoice(name: "model", aliases: ["/model"], source: .command, acceptsArgs: true),
        ]
        let (transport, vm) = await makeViewModel(
            sessionKey: "agent:reviewer:main",
            historyResponses: [historyPayload()],
            commandResponses: [commands])

        await MainActor.run { vm.loadSlashCommandsIfNeeded() }
        try await waitUntil("slash commands loaded") {
            await MainActor.run { vm.hasLoadedSlashCommands }
        }

        #expect(await transport.commandSessionKeys() == ["agent:reviewer:main"])
    }

    @Test func `unknown leading slash is sent to gateway after command catalog loads`() async throws {
        let commands = [
            commandChoice(name: "model", aliases: ["/model"], source: .command, acceptsArgs: true),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload(), historyPayload()],
            commandResponses: [commands])
        try await loadAndWaitBootstrap(vm: vm)

        await sendUserMessage(vm, text: "/does-not-exist")
        _ = try await waitForLastSentRunId(transport)

        #expect(await transport.sentMessages() == ["/does-not-exist"])
    }

    @Test func `double slash sends as ordinary text`() async throws {
        let commands = [
            commandChoice(name: "model", aliases: ["/model"], source: .command, acceptsArgs: true),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [historyPayload(), historyPayload()],
            commandResponses: [commands])
        try await loadAndWaitBootstrap(vm: vm)

        await sendUserMessage(vm, text: "//does-not-trigger")
        _ = try await waitForLastSentRunId(transport)

        #expect(await transport.sentMessages() == ["//does-not-trigger"])
    }

    @Test func `bootstraps model selection from session and defaults`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(model: "openai/gpt-4.1-mini", contextTokens: nil),
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: "anthropic/claude-opus-4-6"),
            ])
        let models = [
            modelChoice(id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6"),
            modelChoice(id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai"),
        ]

        let (_, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models])

        try await loadAndWaitBootstrap(vm: vm)

        #expect(await MainActor.run { vm.showsModelPicker })
        #expect(await MainActor.run { vm.modelSelectionID } == "anthropic/claude-opus-4-6")
        #expect(await MainActor.run { vm.defaultModelLabel } == "Default: openai/gpt-4.1-mini")
    }

    @Test func `selecting default model patches nil and updates selection`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(model: "openai/gpt-4.1-mini", contextTokens: nil),
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: "anthropic/claude-opus-4-6"),
            ])
        let models = [
            modelChoice(id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6"),
            modelChoice(id: "openai/gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models])

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run { vm.selectModel(OpenClawChatViewModel.defaultModelSelectionID) }

        try await waitUntil("session model patched") {
            let patched = await transport.patchedModels()
            return patched == [nil]
        }

        #expect(await MainActor.run { vm.modelSelectionID } == OpenClawChatViewModel.defaultModelSelectionID)
    }

    @Test func `selecting provider qualified model disambiguates duplicate model I ds`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(model: "openrouter/gpt-4.1-mini", contextTokens: nil),
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: "gpt-4.1-mini", modelProvider: "openrouter"),
            ])
        let models = [
            modelChoice(id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openai"),
            modelChoice(id: "gpt-4.1-mini", name: "GPT-4.1 mini", provider: "openrouter"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models])

        try await loadAndWaitBootstrap(vm: vm)

        #expect(await MainActor.run { vm.modelSelectionID } == "openrouter/gpt-4.1-mini")

        await MainActor.run { vm.selectModel("openai/gpt-4.1-mini") }

        try await waitUntil("provider-qualified model patched") {
            let patched = await transport.patchedModels()
            return patched == ["openai/gpt-4.1-mini"]
        }
    }

    @Test func `slash model I ds stay provider qualified in selection and patch`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
            ])
        let models = [
            modelChoice(
                id: "openai/gpt-5.4",
                name: "GPT-5.4 via Vercel AI Gateway",
                provider: "vercel-ai-gateway"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models])

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run { vm.selectModel("vercel-ai-gateway/openai/gpt-5.4") }

        try await waitUntil("slash model patched with provider-qualified ref") {
            let patched = await transport.patchedModels()
            return patched == ["vercel-ai-gateway/openai/gpt-5.4"]
        }
    }

    @Test func `stale model patch completions do not overwrite newer selection`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
            modelChoice(id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    try await Task.sleep(for: .milliseconds(200))
                }
            })

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.selectModel("openai/gpt-5.4")
            vm.selectModel("openai/gpt-5.4-pro")
        }

        try await waitUntil("two model patches complete") {
            let patched = await transport.patchedModels()
            return patched == ["openai/gpt-5.4", "openai/gpt-5.4-pro"]
        }

        #expect(await MainActor.run { vm.modelSelectionID } == "openai/gpt-5.4-pro")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.model } == "gpt-5.4-pro")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.modelProvider } == "openai")
    }

    @Test func `send waits for in flight model patch to finish`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
        ]
        let gate = AsyncGate()

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    await gate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run { vm.selectModel("openai/gpt-5.4") }
        try await waitUntil("model patch started") {
            let patched = await transport.patchedModels()
            return patched == ["openai/gpt-5.4"]
        }

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("send entered waiting state") {
            await MainActor.run { vm.isSending }
        }
        #expect(await transport.lastSentRunId() == nil)

        await MainActor.run { vm.selectThinkingLevel("high") }
        try await waitUntil("thinking level changed while send is blocked") {
            await MainActor.run { vm.thinkingLevel == "high" }
        }

        await gate.open()

        try await waitUntil("send released after model patch") {
            await transport.lastSentRunId() != nil
        }
        #expect(await transport.sentThinkingLevels() == ["off"])
    }

    @Test func `failed latest model selection does not replay after older completion finishes`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
            modelChoice(id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    try await Task.sleep(for: .milliseconds(200))
                    return
                }
                if model == "openai/gpt-5.4-pro" {
                    throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"])
                }
            })

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.selectModel("openai/gpt-5.4")
            vm.selectModel("openai/gpt-5.4-pro")
        }

        try await waitUntil("older model completion wins after latest failure") {
            await MainActor.run {
                vm.sessions.first(where: { $0.key == "main" })?.model == "gpt-5.4" &&
                    vm.sessions.first(where: { $0.key == "main" })?.modelProvider == "openai"
            }
        }

        #expect(await MainActor.run { vm.modelSelectionID } == "openai/gpt-5.4")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.model } == "gpt-5.4")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.modelProvider } == "openai")
        #expect(await transport.patchedModels() == ["openai/gpt-5.4", "openai/gpt-5.4-pro"])
    }

    @Test func `failed latest model selection restores earlier success without replay`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let history = historyPayload()
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
            modelChoice(id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions],
            modelResponses: [models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    try await Task.sleep(for: .milliseconds(100))
                    return
                }
                if model == "openai/gpt-5.4-pro" {
                    try await Task.sleep(for: .milliseconds(200))
                    throw NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"])
                }
            })

        try await loadAndWaitBootstrap(vm: vm)

        await MainActor.run {
            vm.selectModel("openai/gpt-5.4")
            vm.selectModel("openai/gpt-5.4-pro")
        }

        try await waitUntil("latest failure restores prior successful model") {
            await MainActor.run {
                vm.modelSelectionID == "openai/gpt-5.4" &&
                    vm.sessions.first(where: { $0.key == "main" })?.model == "gpt-5.4" &&
                    vm.sessions.first(where: { $0.key == "main" })?.modelProvider == "openai"
            }
        }

        #expect(await transport.patchedModels() == ["openai/gpt-5.4", "openai/gpt-5.4-pro"])
    }

    @Test @MainActor func `switch session notifies session changed callback`() async throws {
        var changedSessionKeys: [String] = []
        let (_, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
            ],
            onSessionChanged: { changedSessionKeys.append($0) })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.switchSession(to: "other")

        try await waitUntil("user switch bootstrapped target session") {
            await MainActor.run { vm.sessionKey == "other" && vm.sessionId == "sess-other" }
        }
        #expect(changedSessionKeys == ["other"])
    }

    @Test @MainActor func `sync session does not notify session changed callback`() async throws {
        var changedSessionKeys: [String] = []
        let (_, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
            ],
            onSessionChanged: { changedSessionKeys.append($0) })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")

        try await waitUntil("external sync bootstrapped target session") {
            await MainActor.run { vm.sessionKey == "other" && vm.sessionId == "sess-other" }
        }
        #expect(changedSessionKeys.isEmpty)
    }

    @Test @MainActor func `refresh ignores late history from canceled bootstrap for same session`() async throws {
        let staleHistoryGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let staleHistoryReleasedCount = AsyncCounter()
        let (_, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-stale-load",
                    messages: [chatTextMessage(role: "assistant", text: "stale load", timestamp: 1)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-current-refresh",
                    messages: [chatTextMessage(role: "assistant", text: "current refresh", timestamp: 2)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 1 {
                    await staleHistoryGate.wait()
                    _ = await staleHistoryReleasedCount.increment()
                }
            })

        vm.load()
        try await waitUntil("first bootstrap history request is in flight") {
            await mainHistoryCount.current() == 1
        }

        vm.refresh()
        try await waitUntil("refresh bootstrap wins") {
            await MainActor.run {
                vm.sessionId == "sess-current-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "current refresh" }
                    }
            }
        }

        await staleHistoryGate.release()
        try await waitUntil("stale load history resumes") {
            await staleHistoryReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-current-refresh")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale load" }
            }
        })
    }

    @Test @MainActor func `manual refresh invalidates older same session event refresh`() async throws {
        let staleRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let staleRefreshReleasedCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-event-stale",
                    messages: [chatTextMessage(role: "assistant", text: "stale same-session event", timestamp: 1)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-manual-refresh",
                    messages: [chatTextMessage(role: "assistant", text: "current manual refresh", timestamp: 2)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await staleRefreshGate.wait()
                    _ = await staleRefreshReleasedCount.increment()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        transport.emit(.seqGap)
        try await waitUntil("same-session event refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        vm.refresh()
        try await waitUntil("manual refresh wins") {
            await MainActor.run {
                vm.sessionId == "sess-main-manual-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "current manual refresh" }
                    }
            }
        }

        await staleRefreshGate.release()
        try await waitUntil("stale same-session event refresh resumes") {
            await staleRefreshReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-main-manual-refresh")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale same-session event" }
            }
        })
    }

    @Test @MainActor func `failed newer same session refresh does not drop older successful send refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from older success", timestamp: now + 1),
                    ]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
                if count == 3 {
                    throw NSError(
                        domain: "ChatViewModelTests",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "newer event refresh failed"])
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        let runId = try await waitForLastSentRunId(transport)
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))
        try await waitUntil("newer event refresh starts") {
            await mainHistoryCount.current() == 3
        }

        await sendRefreshGate.release()

        try await waitUntil("older successful send refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from older success" }
                    }
            }
        }
    }

    @Test @MainActor func `newer empty terminal refresh does not drop older assistant run refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from older success", timestamp: now + 1),
                    ]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-terminal-empty-refresh",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        let runId = try await waitForLastSentRunId(transport)
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: nil,
                    errorMessage: nil)))
        try await waitUntil("newer empty terminal refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-terminal-empty-refresh" &&
                    vm.pendingRunCount == 0
            }
        }

        await sendRefreshGate.release()

        try await waitUntil("older successful send refresh applies assistant reply") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from older success" }
                    }
            }
        }
    }

    @Test @MainActor func `newer user only terminal refresh after final event message does not drop older assistant run refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from durable history", timestamp: now + 1),
                    ]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-terminal-user-only-refresh",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        let runId = try await waitForLastSentRunId(transport)
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(
                        role: "assistant",
                        text: "reply from final event",
                        timestamp: now + 0.5),
                    errorMessage: nil)))
        try await waitUntil("newer user-only terminal refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-terminal-user-only-refresh" &&
                    !vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from final event" }
                    }
            }
        }

        await sendRefreshGate.release()

        try await waitUntil("older successful send refresh applies durable assistant reply") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from durable history" }
                    }
            }
        }
    }

    @Test @MainActor func `manual refresh user only history does not drop older assistant run refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let (_, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from older success", timestamp: now + 1),
                    ]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-manual-user-only-refresh",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        vm.refresh()
        try await waitUntil("manual user-only refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-manual-user-only-refresh" &&
                    vm.pendingRunCount == 0
            }
        }

        await sendRefreshGate.release()

        try await waitUntil("older successful send refresh applies after manual refresh") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from older success" }
                    }
            }
        }
    }

    @Test @MainActor func `manual refresh older complete history does not drop pending user assistant run refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let olderCompleteMessages = [
            chatTextMessage(role: "user", text: "older question", timestamp: now - 2),
            chatTextMessage(role: "assistant", text: "older answer", timestamp: now - 1),
        ]
        let (_, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main",
                    messages: olderCompleteMessages),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: olderCompleteMessages + [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from pending turn", timestamp: now + 1),
                    ]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-manual-older-complete-refresh",
                    messages: olderCompleteMessages),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        vm.refresh()
        try await waitUntil("manual older complete refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-manual-older-complete-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "older answer" }
                    } &&
                    !vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from pending turn" }
                    }
            }
        }

        await sendRefreshGate.release()

        try await waitUntil("older successful send refresh applies pending turn answer") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from pending turn" }
                    }
            }
        }
    }

    @Test @MainActor func `manual stale complete refresh after final event does not drop durable reply refresh`() async throws {
        let sendRefreshGate = SessionSubscribeGate()
        let eventRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let now = Date().timeIntervalSince1970 * 1000
        let olderCompleteMessages = [
            chatTextMessage(role: "user", text: "older question", timestamp: now - 2),
            chatTextMessage(role: "assistant", text: "older answer", timestamp: now - 1),
        ]
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main",
                    messages: olderCompleteMessages),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: olderCompleteMessages + [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "durable reply", timestamp: now + 1),
                    ]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-event-stale-complete-refresh",
                    messages: olderCompleteMessages),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-manual-stale-complete-refresh",
                    messages: olderCompleteMessages),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await sendRefreshGate.wait()
                }
                if count == 3 {
                    await eventRefreshGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        let runId = try await waitForLastSentRunId(transport)
        try await waitUntil("post-send refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: chatTextMessage(role: "assistant", text: "local final reply", timestamp: now + 0.5),
                    errorMessage: nil)))
        try await waitUntil("local final event reply is visible") {
            await MainActor.run {
                vm.messages.contains { message in
                    message.content.contains { $0.text == "local final reply" }
                }
            }
        }

        vm.refresh()
        try await waitUntil("manual stale complete refresh applies without durable reply") {
            let historyCount = await mainHistoryCount.current()
            let stateMatches = await MainActor.run {
                vm.sessionId == "sess-main-manual-stale-complete-refresh" &&
                    !vm.messages.contains { message in
                        message.content.contains { $0.text == "durable reply" }
                    }
            }
            return historyCount == 4 && stateMatches
        }

        await eventRefreshGate.release()
        try await waitUntil("event stale complete refresh resumes") {
            await MainActor.run {
                vm.sessionId == "sess-main-event-stale-complete-refresh"
            }
        }

        await sendRefreshGate.release()

        try await waitUntil("older durable send refresh applies after manual stale refresh") {
            await MainActor.run {
                vm.sessionId == "sess-main-send-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "durable reply" }
                    }
            }
        }
    }

    @Test @MainActor func `bootstrap history does not overwrite newer same session refresh`() async throws {
        let bootstrapHistoryGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let bootstrapHistoryReleasedCount = AsyncCounter()
        let sessions = OpenClawChatSessionsListResponse(
            ts: Date().timeIntervalSince1970 * 1000,
            path: nil,
            count: 1,
            defaults: nil,
            sessions: [sessionEntry(key: "main", updatedAt: Date().timeIntervalSince1970 * 1000)])
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-bootstrap-stale",
                    messages: [chatTextMessage(role: "assistant", text: "stale bootstrap", timestamp: 1)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-event-newer",
                    messages: [chatTextMessage(role: "assistant", text: "newer event refresh", timestamp: 2)]),
            ],
            sessionsResponses: [sessions],
            modelResponses: [[modelChoice(id: "glm-5.1", name: "GLM 5.1")]],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 1 {
                    await bootstrapHistoryGate.wait()
                    _ = await bootstrapHistoryReleasedCount.increment()
                }
            })

        vm.load()
        try await waitUntil("bootstrap history is in flight") {
            await mainHistoryCount.current() == 1
        }

        transport.emit(.seqGap)
        try await waitUntil("newer same-session refresh applies") {
            await MainActor.run {
                vm.sessionId == "sess-main-event-newer" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "newer event refresh" }
                    }
            }
        }

        await bootstrapHistoryGate.release()
        try await waitUntil("bootstrap history resumes") {
            await bootstrapHistoryReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-main-event-newer")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale bootstrap" }
            }
        })
        try await waitUntil("bootstrap metadata still loads") {
            await MainActor.run {
                vm.healthOK &&
                    vm.sessions.contains { $0.key == "main" } &&
                    vm.modelChoices.contains { $0.modelID == "glm-5.1" }
            }
        }
    }

    @Test @MainActor func `stale fallback refresh keeps retrying while run remains pending`() async throws {
        let staleFallbackGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let staleFallbackReleasedCount = AsyncCounter()
        let now = (Date().timeIntervalSince1970 * 1000) + 10000
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-send-refresh",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-stale-fallback",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-newer-empty-refresh",
                    messages: [chatTextMessage(role: "user", text: "hello", timestamp: now)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-next-fallback",
                    messages: [
                        chatTextMessage(role: "user", text: "hello", timestamp: now),
                        chatTextMessage(role: "assistant", text: "reply from later fallback", timestamp: now + 1),
                    ]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 3 {
                    await staleFallbackGate.wait()
                    _ = await staleFallbackReleasedCount.increment()
                }
            },
            sendMessageStatus: "pending")

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.input = "hello"
        vm.send()
        _ = try await waitForLastSentRunId(transport)
        try await waitUntil("first fallback refresh is in flight") {
            await mainHistoryCount.current() == 3
        }

        emitExternalFinal(transport: transport, runId: "external-run", sessionKey: "main")
        try await waitUntil("newer empty refresh applies") {
            await MainActor.run { vm.sessionId == "sess-main-newer-empty-refresh" }
        }

        await staleFallbackGate.release()
        try await waitUntil("stale fallback resumes") {
            await staleFallbackReleasedCount.current() == 1
        }

        try await waitUntil("later fallback still runs", timeoutSeconds: 7.0) {
            await mainHistoryCount.current() >= 5
        }
        try await waitUntil("later fallback applies assistant reply") {
            await MainActor.run {
                vm.pendingRunCount == 0 &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "reply from later fallback" }
                    }
            }
        }
    }

    @Test @MainActor func `stale bootstrap history does not overwrite latest session`() async throws {
        let staleHistoryGate = SessionSubscribeGate()
        let staleHistoryReleasedCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "other",
                    sessionId: "sess-other-stale",
                    messages: [chatTextMessage(role: "assistant", text: "stale other", timestamp: 1)]),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-current",
                    messages: [chatTextMessage(role: "assistant", text: "current main", timestamp: 2)]),
            ],
            requestHistoryHook: { sessionKey in
                if sessionKey == "other" {
                    await staleHistoryGate.wait()
                    _ = await staleHistoryReleasedCount.increment()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")
        try await waitUntil("other session subscribe starts") {
            await transport.activeSessionKeys().last == "other"
        }

        vm.syncSession(to: "main")
        try await waitUntil("main session wins") {
            await MainActor.run {
                vm.sessionKey == "main" &&
                    vm.sessionId == "sess-main-current" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "current main" }
                    }
            }
        }

        await staleHistoryGate.release()
        try await waitUntil("stale other history resumes") {
            await staleHistoryReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-main-current")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale other" }
            }
        })
    }

    @Test @MainActor func `session switch clears old latest user before new session refreshes`() async throws {
        let staleBootstrapGate = SessionSubscribeGate()
        let otherHistoryCount = AsyncCounter()
        let staleBootstrapReleasedCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main",
                    messages: [chatTextMessage(role: "user", text: "main pending question", timestamp: 1)]),
                historyPayload(
                    sessionKey: "other",
                    sessionId: "sess-other-bootstrap-stale",
                    messages: [chatTextMessage(role: "assistant", text: "stale other bootstrap", timestamp: 2)]),
                historyPayload(
                    sessionKey: "other",
                    sessionId: "sess-other-newer-refresh",
                    messages: [chatTextMessage(role: "assistant", text: "newer other refresh", timestamp: 3)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "other" else { return }
                let count = await otherHistoryCount.increment()
                if count == 1 {
                    await staleBootstrapGate.wait()
                    _ = await staleBootstrapReleasedCount.increment()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")
        try await waitUntil("other bootstrap history is in flight") {
            await otherHistoryCount.current() == 1
        }
        #expect(await MainActor.run { vm.messages.isEmpty })

        transport.emit(.seqGap)
        try await waitUntil("newer other refresh applies") {
            await MainActor.run {
                vm.sessionKey == "other" &&
                    vm.sessionId == "sess-other-newer-refresh" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "newer other refresh" }
                    }
            }
        }

        await staleBootstrapGate.release()
        try await waitUntil("stale other bootstrap resumes") {
            await staleBootstrapReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-other-newer-refresh")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale other bootstrap" }
            }
        })
    }

    @Test @MainActor func `stale seq gap refresh does not overwrite latest session`() async throws {
        let staleRefreshGate = SessionSubscribeGate()
        let mainHistoryCount = AsyncCounter()
        let staleRefreshReleasedCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(
                    sessionKey: "main",
                    sessionId: "sess-main-gap-stale",
                    messages: [chatTextMessage(role: "assistant", text: "stale gap", timestamp: 1)]),
                historyPayload(
                    sessionKey: "other",
                    sessionId: "sess-other-current",
                    messages: [chatTextMessage(role: "assistant", text: "current other", timestamp: 2)]),
            ],
            requestHistoryHook: { sessionKey in
                guard sessionKey == "main" else { return }
                let count = await mainHistoryCount.increment()
                if count == 2 {
                    await staleRefreshGate.wait()
                    _ = await staleRefreshReleasedCount.increment()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        transport.emit(.seqGap)
        try await waitUntil("seq gap refresh is in flight") {
            await mainHistoryCount.current() == 2
        }

        vm.syncSession(to: "other")
        try await waitUntil("other session bootstrap wins") {
            await MainActor.run {
                vm.sessionKey == "other" &&
                    vm.sessionId == "sess-other-current" &&
                    vm.messages.contains { message in
                        message.content.contains { $0.text == "current other" }
                    }
            }
        }

        await staleRefreshGate.release()
        try await waitUntil("stale seq gap refresh resumes") {
            await staleRefreshReleasedCount.current() == 1
        }

        #expect(await MainActor.run { vm.sessionId } == "sess-other-current")
        #expect(await MainActor.run {
            !vm.messages.contains { message in
                message.content.contains { $0.text == "stale gap" }
            }
        })
    }

    @Test @MainActor func `send waiting for model patch does not send after session switch`() async throws {
        let modelPatchGate = SessionSubscribeGate()
        let modelPatchReleasedCount = AsyncCounter()
        let models = [modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai")]
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
            ],
            modelResponses: [models, models],
            setSessionModelHook: { _ in
                await modelPatchGate.wait()
                _ = await modelPatchReleasedCount.increment()
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.selectModel("openai/gpt-5.4")
        try await waitUntil("model patch is in flight") {
            await transport.patchedModels() == ["openai/gpt-5.4"]
        }

        vm.input = "hello before switch"
        vm.send()
        try await waitUntil("send is waiting for model patch") {
            await MainActor.run { vm.pendingRunCount == 1 }
        }

        vm.syncSession(to: "other")
        try await waitUntil("session switch clears pending send") {
            await MainActor.run {
                vm.sessionKey == "other" &&
                    vm.sessionId == "sess-other" &&
                    vm.pendingRunCount == 0
            }
        }

        await modelPatchGate.release()
        try await waitUntil("model patch resumes") {
            await modelPatchReleasedCount.current() == 1
        }
        try await Task.sleep(for: .milliseconds(100))

        #expect(await transport.sentRunIds().isEmpty)
    }

    @Test @MainActor func `stale sync bootstrap restores current active session subscription`() async throws {
        let staleSubscribeGate = SessionSubscribeGate()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
            ],
            setActiveSessionHook: { sessionKey in
                if sessionKey == "other" {
                    await staleSubscribeGate.wait()
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")
        try await waitUntil("stale subscribe is in flight") {
            await transport.activeSessionKeys().last == "other"
        }

        vm.syncSession(to: "main")
        try await waitUntil("current session subscribed") {
            let sessionKey = await MainActor.run { vm.sessionKey }
            let activeSessionKeys = await transport.activeSessionKeys()
            return sessionKey == "main" &&
                Array(activeSessionKeys.suffix(2)) == ["other", "main"]
        }

        await staleSubscribeGate.release()

        try await waitUntil("current session resubscribed after stale subscribe") {
            await Array(transport.activeSessionKeys().suffix(3)) == ["other", "main", "main"]
        }
    }

    @Test @MainActor func `stale subscribe failure reasserts current active session subscription`() async throws {
        let staleSubscribeGate = SessionSubscribeGate()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
            ],
            setActiveSessionHook: { sessionKey in
                if sessionKey == "other" {
                    await staleSubscribeGate.wait()
                    throw NSError(
                        domain: "TestChatTransport",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "stale subscribe failed after side effect"])
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")
        try await waitUntil("stale subscribe is in flight") {
            await transport.activeSessionKeys().last == "other"
        }

        vm.syncSession(to: "main")
        try await waitUntil("current session subscribed") {
            await Array(transport.activeSessionKeys().suffix(2)) == ["other", "main"]
        }

        await staleSubscribeGate.release()

        try await waitUntil("current session resubscribed after stale subscribe failure") {
            await Array(transport.activeSessionKeys().suffix(3)) == ["other", "main", "main"]
        }
    }

    @Test @MainActor func `stale sync repair reasserts latest active session subscription`() async throws {
        let staleSubscribeGate = SessionSubscribeGate()
        let staleRepairGate = SessionSubscribeGate()
        let mainSubscribeCount = AsyncCounter()
        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "final", sessionId: "sess-final"),
            ],
            setActiveSessionHook: { sessionKey in
                if sessionKey == "other" {
                    await staleSubscribeGate.wait()
                }
                if sessionKey == "main" {
                    let count = await mainSubscribeCount.increment()
                    if count == 3 {
                        await staleRepairGate.wait()
                    }
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        vm.syncSession(to: "other")
        try await waitUntil("stale subscribe is in flight") {
            await transport.activeSessionKeys().last == "other"
        }

        vm.syncSession(to: "main")
        try await waitUntil("main session subscribed") {
            await Array(transport.activeSessionKeys().suffix(2)) == ["other", "main"]
        }

        await staleSubscribeGate.release()
        try await waitUntil("stale repair is in flight") {
            await Array(transport.activeSessionKeys().suffix(3)) == ["other", "main", "main"]
        }

        vm.syncSession(to: "final")
        try await waitUntil("newest session subscribed") {
            let sessionKey = await MainActor.run { vm.sessionKey }
            let activeSessionKeys = await transport.activeSessionKeys()
            return sessionKey == "final" && activeSessionKeys.last == "final"
        }

        await staleRepairGate.release()

        try await waitUntil("newest session resubscribed after stale repair") {
            await Array(transport.activeSessionKeys().suffix(3)) == ["main", "final", "final"]
        }
    }

    @Test func `switching sessions ignores late model patch completion from previous session`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let sessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 2,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
                sessionEntry(key: "other", updatedAt: now - 1000, model: nil),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
            ],
            sessionsResponses: [sessions, sessions],
            modelResponses: [models, models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    try await Task.sleep(for: .milliseconds(200))
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        await MainActor.run { vm.selectModel("openai/gpt-5.4") }
        await MainActor.run { vm.switchSession(to: "other") }

        try await waitUntil("switched sessions") {
            await MainActor.run { vm.sessionKey == "other" && vm.sessionId == "sess-other" }
        }
        try await waitUntil("late model patch finished") {
            let patched = await transport.patchedModels()
            return patched == ["openai/gpt-5.4"]
        }

        #expect(await MainActor.run { vm.modelSelectionID } == OpenClawChatViewModel.defaultModelSelectionID)
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "other" })?.model } == nil)
    }

    @Test func `late model completion does not replay current session selection into previous session`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let initialSessions = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 2,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
                sessionEntry(key: "other", updatedAt: now - 1000, model: nil),
            ])
        let sessionsAfterOtherSelection = OpenClawChatSessionsListResponse(
            ts: now,
            path: nil,
            count: 2,
            defaults: nil,
            sessions: [
                sessionEntry(key: "main", updatedAt: now, model: nil),
                sessionEntry(key: "other", updatedAt: now - 1000, model: "openai/gpt-5.4-pro"),
            ])
        let models = [
            modelChoice(id: "gpt-5.4", name: "GPT-5.4", provider: "openai"),
            modelChoice(id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai"),
        ]

        let (transport, vm) = await makeViewModel(
            historyResponses: [
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
                historyPayload(sessionKey: "other", sessionId: "sess-other"),
                historyPayload(sessionKey: "main", sessionId: "sess-main"),
            ],
            sessionsResponses: [initialSessions, initialSessions, sessionsAfterOtherSelection],
            modelResponses: [models, models, models],
            setSessionModelHook: { model in
                if model == "openai/gpt-5.4" {
                    try await Task.sleep(for: .milliseconds(200))
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        await MainActor.run { vm.selectModel("openai/gpt-5.4") }
        await MainActor.run { vm.switchSession(to: "other") }
        try await waitUntil("switched to other session") {
            await MainActor.run { vm.sessionKey == "other" && vm.sessionId == "sess-other" }
        }

        await MainActor.run { vm.selectModel("openai/gpt-5.4-pro") }
        try await waitUntil("both model patches issued") {
            let patched = await transport.patchedModels()
            return patched == ["openai/gpt-5.4", "openai/gpt-5.4-pro"]
        }
        await MainActor.run { vm.switchSession(to: "main") }
        try await waitUntil("switched back to main session") {
            await MainActor.run { vm.sessionKey == "main" && vm.sessionId == "sess-main" }
        }

        try await waitUntil("late model completion updates only the original session") {
            await MainActor.run {
                vm.sessions.first(where: { $0.key == "main" })?.model == "gpt-5.4" &&
                    vm.sessions.first(where: { $0.key == "main" })?.modelProvider == "openai"
            }
        }

        #expect(await MainActor.run { vm.modelSelectionID } == "openai/gpt-5.4")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.model } == "gpt-5.4")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "main" })?.modelProvider } == "openai")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "other" })?.model } == "openai/gpt-5.4-pro")
        #expect(await MainActor.run { vm.sessions.first(where: { $0.key == "other" })?.modelProvider } == nil)
        #expect(await transport.patchedModels() == ["openai/gpt-5.4", "openai/gpt-5.4-pro"])
    }

    @Test func `explicit thinking level wins over history and persists changes`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off")
        let callbackState = await MainActor.run { CallbackBox() }

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            initialThinkingLevel: "high",
            onThinkingLevelChanged: { level in
                callbackState.values.append(level)
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")
        #expect(await MainActor.run { vm.thinkingLevel } == "high")

        await MainActor.run { vm.selectThinkingLevel("medium") }

        try await waitUntil("thinking level patched") {
            let patched = await transport.patchedThinkingLevels()
            return patched == ["medium"]
        }

        #expect(await MainActor.run { vm.thinkingLevel } == "medium")
        #expect(await MainActor.run { callbackState.values } == ["medium"])
    }

    @Test func `server provided thinking levels outside menu are preserved for send`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "xhigh")

        let (transport, vm) = await makeViewModel(historyResponses: [history])

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")
        #expect(await MainActor.run { vm.thinkingLevel } == "xhigh")

        await sendUserMessage(vm, text: "hello")
        try await waitUntil("send uses preserved thinking level") {
            await transport.sentThinkingLevels() == ["xhigh"]
        }
    }

    @Test func `decodes gateway thinking metadata from session list`() throws {
        let json = """
        {
          "defaults": {
            "modelProvider": "anthropic",
            "model": "claude-opus-4-7",
            "thinkingLevels": [
              { "id": "off", "label": "off" },
              { "id": "adaptive", "label": "adaptive" },
              { "id": "max", "label": "maximum" }
            ],
            "thinkingOptions": ["off", "adaptive", "maximum"],
            "thinkingDefault": "adaptive"
          },
          "sessions": [
            {
              "key": "main",
              "modelProvider": "openrouter",
              "model": "deepseek/deepseek-v4",
              "thinkingLevel": "max",
              "thinkingLevels": [
                { "id": "off", "label": "off" },
                { "id": "xhigh", "label": "xhigh" },
                { "id": "max", "label": "max" }
              ],
              "thinkingOptions": ["off", "xhigh", "max"],
              "thinkingDefault": "max"
            }
          ]
        }
        """

        let decoded = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: Data(json.utf8))

        #expect(decoded.defaults?.modelProvider == "anthropic")
        #expect(decoded.defaults?.thinkingLevels?.map(\.id) == ["off", "adaptive", "max"])
        #expect(decoded.defaults?.thinkingLevels?.last?.label == "maximum")
        #expect(decoded.defaults?.thinkingDefault == "adaptive")
        #expect(decoded.sessions.first?.thinkingLevels?.map(\.id) == ["off", "xhigh", "max"])
        #expect(decoded.sessions.first?.thinkingDefault == "max")
    }

    @Test func `session thinking levels drive picker options`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "adaptive")
        let sessions = OpenClawChatSessionsListResponse(
            ts: 1,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: "openai",
                model: "gpt-5.5",
                contextTokens: nil,
                thinkingLevels: [
                    thinkingOption("off"),
                    thinkingOption("low"),
                    thinkingOption("xhigh"),
                    thinkingOption("max", label: "maximum"),
                ],
                thinkingOptions: ["off", "low", "xhigh", "maximum"],
                thinkingDefault: "xhigh"),
            sessions: [
                OpenClawChatSessionEntry(
                    key: "main",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: 1,
                    sessionId: "sess-main",
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: "adaptive",
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    modelProvider: "anthropic",
                    model: "claude-opus-4-7",
                    contextTokens: nil,
                    thinkingLevels: [
                        thinkingOption("off"),
                        thinkingOption("adaptive"),
                        thinkingOption("max", label: "maximum"),
                    ],
                    thinkingOptions: ["off", "adaptive", "maximum"],
                    thinkingDefault: "adaptive"),
            ])

        let (_, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions])

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        #expect(await MainActor.run { vm.thinkingLevel } == "adaptive")
        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.id) } == ["off", "adaptive", "max"])
        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.label) } == ["off", "adaptive", "maximum"])
    }

    @Test func `thinking options fallback and current unsupported level stay visible`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "xhigh")
        let sessions = OpenClawChatSessionsListResponse(
            ts: 1,
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
                    updatedAt: 1,
                    sessionId: "sess-main",
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: "xhigh",
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    modelProvider: "openrouter",
                    model: "deepseek/deepseek-v4",
                    contextTokens: nil,
                    thinkingLevels: nil,
                    thinkingOptions: ["off", "max"],
                    thinkingDefault: "max"),
            ])

        let (_, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions])

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        #expect(await MainActor.run { vm.thinkingLevel } == "xhigh")
        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.id) } == ["off", "max", "xhigh"])
        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.label) } == ["off", "max", "xhigh"])
    }

    @Test func `matching default thinking levels beat legacy row thinking options`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "adaptive")
        let sessions = OpenClawChatSessionsListResponse(
            ts: 1,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: "anthropic",
                model: "claude-opus-4-7",
                contextTokens: nil,
                thinkingLevels: [
                    thinkingOption("off"),
                    thinkingOption("adaptive"),
                    thinkingOption("max"),
                ],
                thinkingOptions: ["off", "adaptive", "max"],
                thinkingDefault: "adaptive"),
            sessions: [
                OpenClawChatSessionEntry(
                    key: "main",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: 1,
                    sessionId: "sess-main",
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: "adaptive",
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    modelProvider: "anthropic",
                    model: "claude-opus-4-7",
                    contextTokens: nil,
                    thinkingLevels: nil,
                    thinkingOptions: ["off"],
                    thinkingDefault: "off"),
            ])

        let (_, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions])

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.id) } == ["off", "adaptive", "max"])
    }

    @Test func `default thinking levels do not leak to different session model`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "max")
        let sessions = OpenClawChatSessionsListResponse(
            ts: 1,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: "anthropic",
                model: "claude-opus-4-7",
                contextTokens: nil,
                thinkingLevels: [
                    thinkingOption("off"),
                    thinkingOption("adaptive"),
                    thinkingOption("max"),
                ],
                thinkingOptions: ["off", "adaptive", "max"],
                thinkingDefault: "adaptive"),
            sessions: [
                OpenClawChatSessionEntry(
                    key: "main",
                    kind: nil,
                    displayName: nil,
                    surface: nil,
                    subject: nil,
                    room: nil,
                    space: nil,
                    updatedAt: 1,
                    sessionId: "sess-main",
                    systemSent: nil,
                    abortedLastRun: nil,
                    thinkingLevel: "max",
                    verboseLevel: nil,
                    inputTokens: nil,
                    outputTokens: nil,
                    totalTokens: nil,
                    modelProvider: "openai",
                    model: "gpt-5.4",
                    contextTokens: nil),
            ])

        let (_, vm) = await makeViewModel(
            historyResponses: [history],
            sessionsResponses: [sessions])

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        #expect(await MainActor.run { vm.thinkingLevel } == "max")
        #expect(await MainActor.run { vm.thinkingLevelOptions.map(\.id) } ==
            ["off", "minimal", "low", "medium", "high", "max"])
    }

    @Test func `stale thinking patch completion reapplies latest selection`() async throws {
        let history = OpenClawChatHistoryPayload(
            sessionKey: "main",
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off")

        let (transport, vm) = await makeViewModel(
            historyResponses: [history],
            setSessionThinkingHook: { level in
                if level == "medium" {
                    try await Task.sleep(for: .milliseconds(200))
                }
            })

        try await loadAndWaitBootstrap(vm: vm, sessionId: "sess-main")

        await MainActor.run {
            vm.selectThinkingLevel("medium")
            vm.selectThinkingLevel("high")
        }

        try await waitUntil("thinking patch replayed latest selection") {
            let patched = await transport.patchedThinkingLevels()
            return patched == ["medium", "high", "high"]
        }

        #expect(await MainActor.run { vm.thinkingLevel } == "high")
    }

    @Test func `clears streaming on external error event`() async throws {
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

    @Test func `strips inbound metadata from history messages`() async throws {
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

    @Test func `abort requests do not clear pending until aborted event`() async throws {
        let sessionId = "sess-main"
        let history = historyPayload(sessionId: sessionId)
        let (transport, vm) = await makeViewModel(
            historyResponses: [history, history],
            sendMessageStatus: "pending")
        try await loadAndWaitBootstrap(vm: vm, sessionId: sessionId)

        await sendUserMessage(vm)
        try await waitUntil("pending run starts") { await MainActor.run { vm.pendingRunCount == 1 } }

        let runId = try await waitForLastSentRunId(transport)
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
