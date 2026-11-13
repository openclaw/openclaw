import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite(.timeLimit(.minutes(1)))
@MainActor
struct ChatHistoryReadinessTests {
    @Test(arguments: [false, true], [false, true])
    func `applied history is readable while session metadata or models remain blocked`(
        blockModels: Bool,
        emptyHistory: Bool) async throws
    {
        let gate = OutboxTestGate()
        let transport = TestChatTransport(
            historyResponses: [Self.history(activeRun: blockModels && !emptyHistory, empty: emptyHistory)],
            modelCatalogHook: { _ in
                if blockModels { await gate.wait() }
                return nil
            },
            listSessionsHook: { _ in
                if !blockModels { await gate.wait() }
                return nil
            })
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        defer { vm.detachTransport() }
        vm.load()
        #expect(!vm.hasReadableHistory)
        await gate.waitUntilStarted()

        #expect(vm.messages.first?.content.first?.text == (emptyHistory ? nil : "Saved question"))
        #expect(vm.hasReadableHistory)
        #expect(vm.isLoading)
        #expect(vm.hasCurrentSessionMetadata == blockModels)
        if blockModels, !emptyHistory {
            #expect(vm.streamingAssistantText == "Live answer")
            #expect(vm.pendingRunCount == 1)
            vm.input = "Do not send while this run is active"
            #expect(!vm.canSend)
        }

        let bootstrap = try #require(vm.bootstrapTask)
        await gate.release()
        await bootstrap.value
        #expect(!vm.isLoading)
        // Finishing optional startup must not emit another not-ready -> ready transition
        // for the reader's one-shot initial anchor. Native scrolling is verified separately.
        #expect(vm.hasReadableHistory)
        #expect(vm.messages.first?.content.first?.text == (emptyHistory ? nil : "Saved question"))
    }

    @Test(arguments: [false, true])
    func `retired bootstrap cannot release the next session or alias owner`(changeAliasOwner: Bool) async throws {
        let oldModels = OutboxTestGate()
        let newHistory = OutboxTestGate()
        let transport = TestChatTransport(
            historyResponses: [],
            modelCatalogHook: { call in
                if call == 0 { await oldModels.wait() }
                return nil
            },
            historyResponseHook: { key, call, _ in
                if call > 0 { await newHistory.wait() }
                return Self.history(sessionKey: key, text: call == 0 ? "Old owner" : "New owner")
            })
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport, activeAgentId: "main")
        defer { vm.detachTransport() }
        vm.load()
        await oldModels.waitUntilStarted()
        let oldBootstrap = try #require(vm.bootstrapTask)
        #expect(vm.hasReadableHistory)

        if changeAliasOwner {
            vm.syncDeliveryIdentity(activeAgentId: "work", sessionRoutingContract: "per-sender|work-main|work")
        } else {
            vm.switchSession(to: "other")
        }
        await newHistory.waitUntilStarted()
        await oldModels.release()
        await oldBootstrap.value
        #expect(vm.messages.isEmpty)
        #expect(vm.isLoading)
        #expect(!vm.hasReadableHistory)

        let newBootstrap = try #require(vm.bootstrapTask)
        await newHistory.release()
        await newBootstrap.value
        #expect(vm.messages.first?.content.first?.text == "New owner")
        #expect(vm.hasReadableHistory)
    }

    @Test func `detached history cannot publish reader readiness`() async throws {
        let historyGate = OutboxTestGate()
        let transport = TestChatTransport(
            historyResponses: [Self.history()],
            requestHistoryHook: { _ in await historyGate.wait() })
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.load()
        await historyGate.waitUntilStarted()
        let history = try #require(vm.historyRefresh?.task)
        let bootstrap = try #require(vm.bootstrapTask)
        vm.detachTransport()
        await historyGate.release()
        _ = await history.value
        await bootstrap.value
        #expect(vm.messages.isEmpty)
        #expect(!vm.hasAppliedLiveHistory)
    }

    @Test func `failed cold history retains durable local rows without accepted history`() async throws {
        let (store, databases, directory) = try makeOutboxStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "readiness-offline",
            text: "Queued offline input",
            createdAt: Date().timeIntervalSince1970 * 1000)))
        let historyGate = OutboxTestGate()
        let transport = TestChatTransport(historyResponses: [], requestHistoryHook: { _ in
            await historyGate.wait()
            throw ReadinessHistoryError.unavailable
        })
        let vm = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            activeAgentId: "main",
            sessionRoutingContract: "per-sender|main|main",
            outbox: store)
        defer { vm.detachTransport() }
        vm.load()
        await historyGate.waitUntilStarted()
        try await waitForOutboxState { vm.hasRestoredOutboxMessages }
        #expect(vm.messages.first?.content.first?.text == "Queued offline input")
        #expect(vm.isLoading && !vm.hasReadableHistory)
        let bootstrap = try #require(vm.bootstrapTask)
        await historyGate.release()
        await bootstrap.value
        #expect(!vm.hasReadableHistory)
        #expect(!vm.isLoading)
        #expect(!vm.hasAppliedLiveHistory)
        #expect(vm.messages.first?.content.first?.text == "Queued offline input")
        #expect(vm.outboxStatesByMessageID.count == 1)
        #expect(vm.errorText != nil)
        #expect(!vm.healthOK)
        #expect(!vm.hasCurrentSessionMetadata)
        #expect(await transport.sentMessages().isEmpty)
    }

    private nonisolated static func history(
        sessionKey: String = "main",
        text: String = "Saved question",
        activeRun: Bool = false,
        empty: Bool = false) -> OpenClawChatHistoryPayload
    {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "readiness-session",
            messages: empty ? [] : [AnyCodable([
                "role": "user",
                "content": [["type": "text", "text": text]],
                "timestamp": 1,
            ] as [String: Any])],
            thinkingLevel: "off",
            sessionInfo: OpenClawChatSessionInfo(hasActiveRun: activeRun),
            inFlightRun: activeRun ? OpenClawChatInFlightRun(runId: "readiness-run", text: "Live answer") : nil)
    }
}

private enum ReadinessHistoryError: Error {
    case unavailable
}
