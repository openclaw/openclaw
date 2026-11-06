import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

/// Records every transport read in order; history can be held open to model a slow route.
private final class ReconnectBurstTransport: @unchecked Sendable, OpenClawChatTransport {
    private let lock = NSLock()
    private var log: [String] = []
    private var holdsHistory = false
    private var heldHistory: [CheckedContinuation<Void, Never>] = []
    private var waiters: [(String, CheckedContinuation<Void, Never>)] = []
    private let stream: AsyncStream<OpenClawChatTransportEvent>

    init() {
        (self.stream, _) = AsyncStream.makeStream()
    }

    var requests: [String] {
        self.lock.withLock { self.log }
    }

    func reset(holdingHistory: Bool) {
        self.lock.withLock {
            self.log = []
            self.holdsHistory = holdingHistory
        }
    }

    func releaseHistory() {
        let held = self.lock.withLock {
            self.holdsHistory = false
            defer { self.heldHistory = [] }
            return self.heldHistory
        }
        held.forEach { $0.resume() }
    }

    func waitFor(_ request: String) async {
        await withCheckedContinuation { continuation in
            self.lock.withLock {
                if self.log.contains(request) {
                    continuation.resume()
                } else {
                    self.waiters.append((request, continuation))
                }
            }
        }
    }

    private func record(_ request: String) {
        let ready = self.lock.withLock {
            self.log.append(request)
            let ready = self.waiters.filter { $0.0 == request }.map(\.1)
            self.waiters.removeAll { $0.0 == request }
            return ready
        }
        ready.forEach { $0.resume() }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.record("history")
        await withCheckedContinuation { continuation in
            let hold = self.lock.withLock {
                if self.holdsHistory { self.heldHistory.append(continuation) }
                return self.holdsHistory
            }
            if !hold { continuation.resume() }
        }
        self.record("history.done")
        return OpenClawChatHistoryPayload(sessionKey: sessionKey, sessionId: "s1", messages: [], thinkingLevel: "off")
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        self.record("models")
        return []
    }

    var supportsComposerCapabilities: Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey _: String,
        agentID _: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        self.record("composer")
        return OpenClawChatComposerCapabilityCatalog()
    }

    func isSwarmEnabled(sessionKey _: String) async throws -> Bool {
        self.record("swarm")
        return false
    }

    func listQuestions() async throws -> [QuestionRecord] {
        self.record("questions")
        return []
    }

    func loadSourceContext() async -> OpenClawChatSourceContext? {
        self.record("source")
        return nil
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        self.record("health")
        return true
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        OpenClawChatSendResponse(runId: idempotencyKey, status: "accepted")
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        self.record("sessions")
        return OpenClawChatSessionsListResponse(ts: nil, path: nil, count: 0, defaults: nil, sessions: [])
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }
}

struct ChatViewModelReconnectBurstTests {
    @Test @MainActor func `flapping reconnects recover history before one catalog refresh`() async {
        let transport = ReconnectBurstTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        defer { vm.detachTransport() }
        #expect(await vm.refreshHistoryAfterRun().applied)
        await vm.pollHealthIfNeeded(force: true)
        transport.reset(holdingHistory: true)

        // A flapping cell link: reconnect, health drops and returns, reconnect again.
        let first = vm.handleTransportEvent(.reconnected)
        vm.handleTransportEvent(.health(ok: false))
        vm.handleTransportEvent(.health(ok: true))
        let second = vm.handleTransportEvent(.reconnected)
        await transport.waitFor("history")
        transport.releaseHistory()
        await first?.value
        await second?.value
        await transport.waitFor("source")

        let requests = transport.requests
        print("RECONNECT_BURST requests=", requests.joined(separator: ","))
        let catalogs = ["models", "composer", "swarm", "questions", "source"]
        let historyDone = requests.lastIndex(of: "history.done") ?? requests.endIndex
        for catalog in catalogs {
            #expect(requests.count(where: { $0 == catalog }) == 1, "\(catalog) refreshes once per settled recovery")
            #expect((requests.firstIndex(of: catalog) ?? -1) > historyDone, "\(catalog) waits for history")
        }
        #expect(requests.first == "history")
    }
}
