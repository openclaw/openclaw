import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

/// Minimal transport for the task-list header actions; unrelated protocol methods keep
/// their defaults.
private final class ProgressCardActionTestTransport: @unchecked Sendable, OpenClawChatTransport {
    struct ClearCall: Equatable {
        let sessionKey: String
        let agentID: String?
        let expectedRevision: Int
    }

    private let lock = NSLock()
    private var cardStorage: ProgressCard?
    private var clearsStorage: [ClearCall] = []
    private var refreshKeysStorage: [String] = []
    private let refreshSignals = AsyncStream<Void>.makeStream()
    private var refreshErrorStorage: Error?
    private let advertisesRefresh: Bool
    private let clearFails: Bool

    init(card: ProgressCard, advertisesRefresh: Bool = true, clearFails: Bool = false) {
        self.cardStorage = card
        self.advertisesRefresh = advertisesRefresh
        self.clearFails = clearFails
    }

    var clears: [ClearCall] {
        self.lock.withLock { self.clearsStorage }
    }

    var refreshKeys: [String] {
        self.lock.withLock { self.refreshKeysStorage }
    }

    /// `terminal` is the Gateway's answer for an attempt that ended without a new card.
    func setRefreshFails(_ fails: Bool, terminal: Bool = false) {
        var error: Error?
        if fails, terminal {
            error = GatewayResponseError(
                method: "progressCard.refresh", code: "UNAVAILABLE", message: "refresh ended",
                details: ["code": AnyCodable("PROGRESS_CARD_REFRESH_TERMINAL")])
        } else if fails {
            error = NSError(domain: "ProgressCardActionTestTransport", code: 2)
        }
        let stored = error
        self.lock.withLock { self.refreshErrorStorage = stored }
    }

    /// Returns once this many refresh requests have arrived; each request signals its arrival.
    func refreshes(atLeast count: Int) async {
        if self.refreshKeys.count >= count { return }
        for await _ in self.refreshSignals.stream where self.refreshKeys.count >= count {
            return
        }
    }

    func setCard(_ card: ProgressCard?) {
        self.lock.withLock { self.cardStorage = card }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "sess-main",
            messages: [],
            thinkingLevel: "off",
            sessionInfo: OpenClawChatSessionInfo(hasActiveRun: false, key: "agent:main:main", agentId: "main"))
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw NSError(domain: "ProgressCardActionTestTransport", code: 1)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.finish()
        }
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        method == "progressCard.get" || (self.advertisesRefresh && method == "progressCard.refresh")
    }

    func fetchProgressCard(sessionKey _: String, agentID _: String?) async throws -> ProgressCard? {
        self.lock.withLock { self.cardStorage }
    }

    func clearProgressCard(sessionKey: String, agentID: String?, expectedRevision: Int) async throws {
        let failed = self.lock.withLock {
            self.clearsStorage.append(ClearCall(
                sessionKey: sessionKey,
                agentID: agentID,
                expectedRevision: expectedRevision))
            if !self.clearFails { self.cardStorage = nil }
            return self.clearFails
        }
        if failed { throw NSError(domain: "ProgressCardActionTestTransport", code: 2) }
    }

    func refreshProgressCard(sessionKey _: String, agentID _: String?, idempotencyKey: String) async throws {
        let error = self.lock.withLock {
            self.refreshKeysStorage.append(idempotencyKey)
            return self.refreshErrorStorage
        }
        self.refreshSignals.continuation.yield()
        if let error { throw error }
    }
}

private func progressCard(revision: Int) -> ProgressCard {
    ProgressCard(
        sessionkey: "agent:main:main",
        revision: revision,
        updatedat: revision * 1000,
        markdown: nil,
        steps: [ProgressCardStep(step: "Implement", status: .inProgress)])
}

@MainActor
private func loadedViewModel(_ transport: ProgressCardActionTestTransport) async throws -> OpenClawChatViewModel {
    let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
    vm.load()
    await vm.bootstrapTask?.value
    await waitForObservedState { vm.progressCard?.revision == 7 }
    return vm
}

@MainActor
struct ChatViewModelProgressCardActionTests {
    @Test func `clearing the saved card sends the shown revision and removes the card`() async throws {
        let transport = ProgressCardActionTestTransport(card: progressCard(revision: 7))
        let vm = try await loadedViewModel(transport)

        vm.clearSavedProgressCard()

        await waitForObservedState { vm.progressCard == nil }
        #expect(transport.clears == [
            .init(sessionKey: "agent:main:main", agentID: "main", expectedRevision: 7),
        ])
    }

    @Test func `a failed clear keeps the card and reports the failure`() async throws {
        let transport = ProgressCardActionTestTransport(card: progressCard(revision: 7), clearFails: true)
        let vm = try await loadedViewModel(transport)

        vm.clearSavedProgressCard()

        await waitForObservedState { vm.errorText == "Could not clear the saved plan." }
        #expect(transport.clears.count == 1)
        #expect(vm.progressCard?.revision == 7)
    }

    @Test func `refresh sends one request while pending and again after the card changes`() async throws {
        let transport = ProgressCardActionTestTransport(card: progressCard(revision: 7))
        let vm = try await loadedViewModel(transport)

        vm.requestProgressCardRefresh()
        vm.requestProgressCardRefresh()
        #expect(vm.progressCardRefreshPending)
        await transport.refreshes(atLeast: 1)

        // The updated card is what ends the wait.
        transport.setCard(progressCard(revision: 8))
        await vm.handleTransportEvent(.progressCardChanged(ProgressCardChangedEvent(
            sessionkey: "agent:main:main",
            revision: AnyCodable(8))))?.value
        #expect(vm.progressCard?.revision == 8)
        #expect(!vm.progressCardRefreshPending)
        #expect(transport.refreshKeys.count == 1)

        vm.requestProgressCardRefresh()
        await transport.refreshes(atLeast: 2)
        #expect(Set(transport.refreshKeys).count == 2)
        vm.progressCardRefreshTask?.cancel()
    }

    @Test func `a refresh retried after a failure repeats its key`() async throws {
        let transport = ProgressCardActionTestTransport(card: progressCard(revision: 7))
        transport.setRefreshFails(true)
        let vm = try await loadedViewModel(transport)

        vm.requestProgressCardRefresh()
        await waitForObservedState {
            !vm.progressCardRefreshPending && vm.errorText == "Could not refresh the plan."
        }
        // The request may have been accepted before it failed to answer, so the retry must not look new.
        transport.setRefreshFails(false)
        // A newer card was saved meanwhile but its change event never arrived: the retry reads it.
        transport.setCard(progressCard(revision: 8))
        vm.requestProgressCardRefresh()
        await transport.refreshes(atLeast: 2)
        #expect(Set(transport.refreshKeys).count == 1)
        await waitForObservedState { vm.progressCard?.revision == 8 && !vm.progressCardRefreshPending }
    }

    @Test func `a refresh the gateway ended is not replayed by the next tap`() async throws {
        let transport = ProgressCardActionTestTransport(card: progressCard(revision: 7))
        transport.setRefreshFails(true, terminal: true)
        let vm = try await loadedViewModel(transport)

        vm.requestProgressCardRefresh()
        await waitForObservedState {
            !vm.progressCardRefreshPending && vm.errorText == "Could not refresh the plan."
        }
        transport.setRefreshFails(false)
        vm.requestProgressCardRefresh()
        await transport.refreshes(atLeast: 2)
        #expect(Set(transport.refreshKeys).count == 2)
        vm.progressCardRefreshTask?.cancel()
    }

    @Test(arguments: [false, true])
    func `refresh is offered only when the gateway advertises it`(advertised: Bool) async throws {
        let transport = ProgressCardActionTestTransport(
            card: progressCard(revision: 7),
            advertisesRefresh: advertised)
        let vm = try await loadedViewModel(transport)

        #expect(vm.progressCardRefreshAvailable == advertised)
    }
}
