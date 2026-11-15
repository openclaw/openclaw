import Foundation
import Testing
@testable import OpenClawChatUI

/// Minimal transport for delete-session flows; unrelated protocol methods keep
/// their throwing defaults.
private final class DeleteSessionTestTransport: @unchecked Sendable, OpenClawChatTransport {
    private let lock = NSLock()
    private var deletedKeysStorage: [String] = []
    private var historyRequestsStorage: [String] = []
    private let deletionRefresh = AsyncStream<Void>.makeStream()

    var deletedKeys: [String] {
        self.lock.withLock { self.deletedKeysStorage }
    }

    var historyRequests: [String] {
        self.lock.withLock { self.historyRequestsStorage }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.lock.withLock { self.historyRequestsStorage.append(sessionKey) }
        let json = """
        {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
        """
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(json.utf8))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let json = """
        {"runId":"\(UUID().uuidString)","status":"ok"}
        """
        return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: Data(json.utf8))
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func deleteSession(key: String) async throws {
        self.lock.withLock { self.deletedKeysStorage.append(key) }
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        if !self.deletedKeys.isEmpty { self.deletionRefresh.continuation.yield(()) }
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }

    func waitForDeletionRefresh() async {
        var iterator = self.deletionRefresh.stream.makeAsyncIterator()
        _ = await iterator.next()
    }
}

@MainActor
struct ChatViewModelSessionDeletionTests {
    @Test func `deleting the active main session re-bootstraps in place`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.load()
        await vm.bootstrapTask?.value
        #expect(transport.historyRequests.contains("main"))

        let historyCountBeforeDelete = transport.historyRequests.count
        vm.deleteSession("main")

        await transport.waitForDeletionRefresh()
        #expect(transport.deletedKeys == ["main"])
        // The main key stays the address after deletion, so the view model
        // must re-bootstrap it rather than silently keeping dead state.
        await vm.bootstrapTask?.value
        #expect(transport.historyRequests.count > historyCountBeforeDelete)
        #expect(vm.sessionKey == "main")
    }

    @Test func `deleting the active non-main session switches to main`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "scratch", transport: transport)
        vm.load()
        await vm.bootstrapTask?.value
        #expect(transport.historyRequests.contains("scratch"))

        vm.deleteSession("scratch")

        await transport.waitForDeletionRefresh()
        #expect(transport.deletedKeys == ["scratch"])
        await vm.bootstrapTask?.value
        #expect(vm.sessionKey == "main")
    }

    @Test func `deleting an ordinary qualified global row preserves the bare global conversation`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "global",
            transport: transport,
            activeAgentId: "ops")
        vm.load()
        await vm.bootstrapTask?.value
        #expect(transport.historyRequests.contains("global"))

        vm.deleteSession("agent:ops:global")

        await transport.waitForDeletionRefresh()
        #expect(transport.deletedKeys == ["agent:ops:global"])
        #expect(await MainActor.run { vm.sessionKey == "global" })
    }

    @Test func `deleting an inactive session keeps the active one`() async throws {
        let transport = DeleteSessionTestTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.load()
        await vm.bootstrapTask?.value
        #expect(transport.historyRequests.contains("main"))

        vm.deleteSession("scratch")

        await transport.waitForDeletionRefresh()
        #expect(transport.deletedKeys == ["scratch"])
        #expect(vm.sessionKey == "main")
    }
}
