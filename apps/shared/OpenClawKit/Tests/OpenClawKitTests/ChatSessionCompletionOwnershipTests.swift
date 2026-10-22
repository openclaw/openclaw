import Foundation
import Testing
@testable import OpenClawChatUI

private enum SessionCompletionAction: Sendable {
    case compact
    case fork
    case rewind
    case forkAtMessage

    @MainActor
    func perform(on viewModel: OpenClawChatViewModel) async {
        let message = OpenClawChatMessage(
            role: "user", content: [], timestamp: nil, transcriptMessageID: "message-42")
        switch self {
        case .compact: await viewModel.performCompact()
        case .fork: await viewModel.forkSession(key: "main")
        case .rewind: await viewModel.rewindToMessage(message)
        case .forkAtMessage: await viewModel.forkAtMessage(message)
        }
    }
}

private actor SessionCompletionCalls {
    var historyKeys: [String] = []
    var actionKeys: [String] = []

    func recordHistory(_ key: String) {
        self.historyKeys.append(key)
    }

    func recordAction(_ key: String) {
        self.actionKeys.append(key)
    }
}

private final class SessionCompletionTransport: OpenClawChatTransport {
    let calls = SessionCompletionCalls()
    private let fails: Bool
    private let started = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    private let released = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))

    init(fails: Bool) {
        self.fails = fails
    }

    func waitUntilStarted() async -> Bool {
        var iterator = self.started.stream.makeAsyncIterator()
        return await iterator.next() != nil
    }

    func release() {
        self.released.continuation.yield()
    }

    func finish() {
        self.started.continuation.finish()
        self.released.continuation.finish()
    }

    private func completeAction(_ key: String) async throws {
        await self.calls.recordAction(key)
        self.started.continuation.yield()
        var iterator = self.released.stream.makeAsyncIterator()
        _ = await iterator.next()
        if self.fails {
            throw NSError(domain: "SessionCompletionTests", code: 1)
        }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await self.calls.recordHistory(sessionKey)
        if sessionKey == "other" {
            throw NSError(
                domain: "SessionCompletionTests",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Replacement history unavailable"])
        }
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey, sessionId: "session-main", messages: [], thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }

    func compactSession(sessionKey: String) async throws {
        try await self.completeAction(sessionKey)
    }

    func forkSession(parentKey: String, fromLastCompleted _: Bool) async throws -> String {
        try await self.completeAction(parentKey)
        return "forked"
    }

    func rewindSession(sessionKey: String, entryId _: String) async throws -> OpenClawChatRewindResponse {
        try await self.completeAction(sessionKey)
        return OpenClawChatRewindResponse(editorText: "Old draft", editorAttachments: [])
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId _: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        try await self.completeAction(sessionKey)
        return OpenClawChatForkAtMessageResponse(
            sessionKey: "forked", editorText: "Old draft", editorAttachments: [])
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        OpenClawChatSessionsListResponse(ts: nil, path: nil, count: 0, defaults: nil, sessions: [])
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

@MainActor
struct ChatSessionCompletionOwnershipTests {
    @Test(arguments: [false, true])
    func `compact completion keeps replacement session`(fails: Bool) async throws {
        try await self.assertReplacementSessionSurvives(.compact, fails: fails)
    }

    @Test(arguments: [SessionCompletionAction.fork, .rewind, .forkAtMessage])
    private func `failed action keeps replacement session`(action: SessionCompletionAction) async throws {
        try await self.assertReplacementSessionSurvives(action, fails: true)
    }

    private func assertReplacementSessionSurvives(
        _ action: SessionCompletionAction,
        fails: Bool) async throws
    {
        let suiteName = "ChatSessionCompletionOwnershipTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let transport = SessionCompletionTransport(fails: fails)
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main", transport: transport, modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { viewModel.detachTransport() }
        viewModel.load()
        await viewModel.bootstrapTask?.value

        let completion = Task {
            defer { transport.finish() }
            await action.perform(on: viewModel)
        }
        defer { transport.release() }
        try #require(await transport.waitUntilStarted())
        viewModel.switchSession(to: "other")
        await viewModel.bootstrapTask?.value
        #expect(viewModel.errorText == "Replacement history unavailable")
        viewModel.input = "Replacement draft"
        #expect(await transport.calls.actionKeys == ["main"])
        #expect(await transport.calls.historyKeys == ["main", "other"])

        transport.release()
        await completion.value
        await viewModel.bootstrapTask?.value

        #expect(viewModel.sessionKey == "other")
        #expect(viewModel.input == "Replacement draft")
        #expect(viewModel.errorText == "Replacement history unavailable")
        #expect(!viewModel.isLoading && !viewModel.isCompacting)
        #expect(await transport.calls.historyKeys == ["main", "other"])
    }
}
