import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatToolResultIngestionTests {
    private static func raw(_ json: String) throws -> AnyCodable {
        try JSONDecoder().decode(AnyCodable.self, from: Data(json.utf8))
    }

    private static let parallel = #"""
    {"role":"user","timestamp":3,"__openclaw":{"id":"carrier"},"content":[
      {"type":"tool_result","tool_use_id":"a","name":"exec","content":"Alpha output"},
      {"type":"tool_result","tool_use_id":"b","name":"read","content":[{"type":"text","text":"Beta output"}]}
    ]}
    """#
    private static let calls = #"""
    {"role":"assistant","timestamp":2,"content":[
      {"type":"tool_use","id":"a","name":"exec","arguments":{}},
      {"type":"tool_use","id":"b","name":"read","arguments":{}}
    ]}
    """#
    private static let results = #"""
      {"type":"tool_result","tool_use_id":"a","content":"Alpha output"},
      {"type":"tool_result","tool_use_id":"b","content":"Beta output"}
    """#
    private static let user = #"{"role":"user","timestamp":1,"content":"Check both"}"#
    private static let answer = #"{"role":"assistant","timestamp":4,"stopReason":"stop","content":"Both checked"}"#

    private static func model() -> OpenClawChatViewModel {
        OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
    }

    private static func deliver(_ raw: AnyCodable, to vm: OpenClawChatViewModel) throws {
        try vm.handleTransportEvent(.sessionMessage(.init(
            sessionKey: "main",
            message: GatewayPayloadDecoding.decode(raw, as: OpenClawChatMessage.self),
            messageId: nil,
            messageSeq: nil)))
    }

    private static func mergedResults(_ messages: [OpenClawChatMessage]) -> [String?] {
        ChatTranscriptRow.mergeToolResults(in: messages).first?.content.filter(\.isToolResult).map(\.text) ?? []
    }

    @Test func `parallel results`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(Self.parallel)])
        #expect(messages.map(\.role) == ["toolResult", "toolResult"])
        #expect(messages.map(\.toolCallId) == ["a", "b"])
        #expect(messages.map(\.toolName) == ["exec", "read"])
        #expect(messages.map { ChatMessageVisibleText.displayText(in: $0, includeThinking: false) } == [
            "Alpha output", "Beta output",
        ])
        #expect(messages.map(\.transcriptMessageID) == ["carrier", "carrier"])
        #expect(Set(messages.compactMap(OpenClawChatViewModel.dedupeKey)).count == 2)
        #expect(Set(messages.map(\.id)).count == 2)
        let merged = try ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages(
            [Self.user, Self.calls, Self.parallel, Self.answer].map(Self.raw)))
        #expect(merged.count == 3)
        let results = try #require(merged.first { $0.role == "assistant" }).content.filter(\.isToolResult)
        #expect(results.map(\.text) == ["Alpha output", "Beta output"])
        let rows = ChatTranscriptRow.build(from: merged)
        #expect(rows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(rows, runWorking: false).count == 3)
    }

    @Test func `mixed parallel results precede the next user turn`() throws {
        let calls = try Self.raw(Self.calls)
        let carrier = try Self.raw(#"""
        {"role":"user","timestamp":3,"content":[\#(Self.results),{"type":"text","text":"Next instruction"}]}
        """#)
        let textFirst = try Self.raw(#"""
        {"role":"user","content":[{"type":"text","text":"Actual user text"},\#(Self.results)]}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([textFirst]).map(\.role) == ["toolResult", "toolResult", "user"])
        #expect(OpenClawChatViewModel.decodeMessages([carrier]).map(\.role) == ["toolResult", "toolResult", "user"])
        let merged = ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages([calls, carrier]))
        #expect(merged.map(\.role) == ["assistant", "user"])
        #expect(!merged.contains { $0.isToolResult })
        #expect(Self.mergedResults(OpenClawChatViewModel.decodeMessages([calls, carrier])) == [
            "Alpha output", "Beta output",
        ])
        #expect(merged.last?.content.map(\.text) == ["Next instruction"])
        #expect(ChatTranscriptRow.build(from: merged).filter(\.startsTurn).count == 1)

        let vm = Self.model()
        defer { vm.detachTransport() }
        for raw in [calls, carrier] {
            try Self.deliver(raw, to: vm)
        }
        #expect(vm.messages.map(\.role) == ["assistant", "toolResult", "toolResult", "user"])
        #expect(ChatTranscriptRow.mergeToolResults(in: vm.messages).map(\.role) == ["assistant", "user"])
        let turn = OpenClawChatViewModel.latestUserTurn(in: vm.messages)
        #expect(turn?.timestamp == 3)
        #expect(OpenClawChatViewModel.messageRange(after: turn, in: vm.messages).isEmpty)
        let answer = try Self.raw(#"{"role":"assistant","timestamp":4,"stopReason":"stop","content":"Next answer"}"#)
        #expect(OpenClawChatHistoryPresentation.replyText(
            from: [calls, carrier, answer],
            runID: "legacy-run",
            submittedText: "Next instruction",
            submittedAtMs: 3) == "Next answer")
    }

    @Test func `mixed carrier results precede an adopted optimistic user`() throws {
        let carrier = try Self.raw(#"""
        {"role":"user","timestamp":3,"idempotencyKey":"next:user","__openclaw":{"id":"mixed"},"content":[
          \#(Self.results),{"type":"text","text":"Next instruction"}
        ]}
        """#)
        let optimistic = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Next instruction")],
            timestamp: 2.5,
            idempotencyKey: "next:user")
        let vm = Self.model()
        defer { vm.detachTransport() }
        try vm.replaceMessages([
            GatewayPayloadDecoding.decode(Self.raw(Self.calls), as: OpenClawChatMessage.self),
            optimistic,
        ])
        for _ in 0..<2 {
            try Self.deliver(carrier, to: vm)
            #expect(vm.messages.map(\.role) == ["assistant", "toolResult", "toolResult", "user"])
            #expect(vm.messages.last?.id == optimistic.id)
            #expect(vm.messages.last?.transcriptMessageID == "mixed")
            // Only the user row may answer to the outbox's idempotency key.
            #expect(vm.messages.compactMap(\.idempotencyKey) == ["next:user"])
            #expect(ChatTranscriptRow.mergeToolResults(in: vm.messages).map(\.role) == ["assistant", "user"])
            #expect(Self.mergedResults(vm.messages) == ["Alpha output", "Beta output"])
            #expect(OpenClawChatViewModel.messageRange(
                after: OpenClawChatViewModel.latestUserTurn(in: vm.messages), in: vm.messages).isEmpty)
        }
    }

    @Test func `carrier turn boundary has one owner`() throws {
        let calls = try Self.raw(Self.calls)
        let pure = try Self.raw(#"{"role":"user","__openclaw":{"turnBoundary":true},"content":[\#(Self.results)]}"#)
        let mixed = try Self.raw(#"""
        {"role":"user","__openclaw":{"turnBoundary":true},"content":[
          \#(Self.results),{"type":"text","text":"Next instruction"}
        ]}
        """#)
        let pureMessages = OpenClawChatViewModel.decodeMessages([calls, pure])
        #expect(pureMessages.map(\.turnBoundary) == [nil, true, nil])
        let pureMerged = ChatTranscriptRow.mergeToolResults(in: pureMessages)
        // The real gateway boundary still prevents attachment across turns.
        #expect(pureMerged.map(\.role) == ["assistant", "toolResult", "toolResult"])
        #expect(Self.mergedResults(pureMessages).isEmpty)
        let pureRows = ChatTranscriptRow.build(from: pureMerged)
        #expect(pureRows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(pureRows, runWorking: false)
            .filter(\.startsTurn).count == 1)

        let mixedMessages = OpenClawChatViewModel.decodeMessages([calls, mixed])
        #expect(mixedMessages.map(\.turnBoundary) == [nil, nil, nil, true])
        let mixedMerged = ChatTranscriptRow.mergeToolResults(in: mixedMessages)
        #expect(mixedMerged.map(\.role) == ["assistant", "user"])
        #expect(Self.mergedResults(mixedMessages) == ["Alpha output", "Beta output"])
        let mixedRows = ChatTranscriptRow.build(from: mixedMerged)
        #expect(mixedRows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(mixedRows, runWorking: false)
            .filter(\.startsTurn).count == 1)
    }

    @Test func `unmatched result`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(Self.parallel)])
        let orphan = try #require(ChatTranscriptRow.mergeToolResults(in: messages).first)
        #expect(orphan.isToolResult)
        #expect(ChatTranscriptRow(orphan)?.startsTurn == false)
        #expect(ChatMessageVisibleText.displayText(in: orphan, includeThinking: false) == "Alpha output")
    }

    @Test func `error result preserves metadata`() throws {
        func activity(_ items: String) throws -> [OpenClawChatHistoryActivity] {
            try JSONDecoder().decode(
                [OpenClawChatHistoryActivity].self,
                from: Data(#"[{"messageId":"carrier","items":[\#(items)]}]"#.utf8))
        }
        func item(_ id: String, call: String) -> String {
            #"{"itemId":"\#(id)",\#(call)"kind":"tool","phase":"end","title":"Done","status":"ok"}"#
        }
        let terminalA = item("terminal-a", call: #""toolCallId":"a","#)
        let terminalB = item("terminal-b", call: #""toolCallId":"b","#)
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(#"""
        {"role":"user","isError":true,"details":{"exitCode":1},"__openclaw":{"id":"carrier","runId":"run-a"},"content":[
          {"type":"tool_result","tool_use_id":"a","name":"exec","is_error":true,
           "content":[{"type":"text","text":"Command failed"}]}
        ]}
        """#)], activity: activity("\(terminalA),\(terminalB)"))
        let message = try #require(messages.first)
        #expect(message.role == "toolResult")
        #expect(message.toolCallId == "a")
        #expect(message.isError == true)
        #expect(message.details?.dictionaryValue?["exitCode"] == AnyCodable(1))
        #expect(message.activity?.map(\.itemId) == ["terminal-a"])
        #expect(message.transcriptRunID == "run-a")
        let call = try Self.raw(#"""
        {"role":"assistant","__openclaw":{"runId":"run-a"},"content":[
          {"type":"tool_use","id":"a","name":"exec","arguments":{}}
        ]}
        """#)
        let merged = ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages([call]) + messages)
        let result = try #require(merged.first?.content.last)
        #expect(result.text == "Command failed")
        #expect(result.isError == true)
        #expect(result.details == message.details)
        #expect(merged.first?.activity?.map(\.itemId) == ["terminal-a"])

        let parallelMessages = try OpenClawChatViewModel.decodeMessages(
            [Self.raw(Self.calls), Self.raw(Self.parallel)],
            activity: activity("\(terminalA),\(terminalB),\(item("carrier-status", call: ""))"))
        let parallelMerged = ChatTranscriptRow.mergeToolResults(in: parallelMessages)
        #expect(parallelMerged.count == 1)
        #expect(parallelMerged.first?.activity?.map(\.itemId) == ["terminal-a", "terminal-b"])
    }

    @Test func `conflicting runs stay unmatched`() throws {
        func call(run: String) throws -> AnyCodable {
            try Self.raw(#"""
            {"role":"assistant","__openclaw":{"runId":"\#(run)"},"content":[
              {"type":"tool_use","id":"a","name":"exec","arguments":{}}
            ]}
            """#)
        }
        let messages = try OpenClawChatViewModel.decodeMessages([
            call(run: "run-a"),
            call(run: "run-b"),
            Self.raw(#"""
            {"role":"user","__openclaw":{"runId":"run-a"},"content":[
              {"type":"tool_result","tool_use_id":"a","content":"A output"}
            ]}
            """#),
        ])
        let merged = ChatTranscriptRow.mergeToolResults(in: messages)
        #expect(merged.count == 3)
        #expect(merged.last?.role == "toolResult")
        #expect(merged.first?.content.count == 1)
        let legacy = try OpenClawChatViewModel.decodeMessages([
            call(run: "run-b"),
            Self.raw(#"""
            {"role":"user","idempotencyKey":"run-a:user","content":[
              {"type":"tool_result","tool_use_id":"a","content":"Legacy A output"}
            ]}
            """#),
        ])
        let legacyMerged = ChatTranscriptRow.mergeToolResults(in: legacy)
        #expect(legacyMerged.count == 2)
        #expect(legacyMerged.last?.role == "toolResult")
        #expect(legacyMerged.last?.transcriptRunID == "run-a")
    }

    @Test func `latest user, legacy range and voice fallback ignore carriers`() throws {
        let raw = try [Self.user, Self.answer, Self.parallel].map(Self.raw)
        let messages = OpenClawChatViewModel.decodeMessages(raw)
        #expect(!OpenClawChatViewModel.hasUnansweredLatestUser(in: messages))
        #expect(OpenClawChatViewModel.latestUserTurn(in: messages)?.timestamp == 1)
        let turn = try OpenClawChatViewModel.latestUserTurn(
            in: OpenClawChatViewModel.decodeMessages([Self.raw(Self.user)]))
        let orderedRaw = try [Self.user, Self.parallel, Self.answer].map(Self.raw)
        let ordered = OpenClawChatViewModel.decodeMessages(orderedRaw)
        let range = OpenClawChatViewModel.messageRange(after: turn, in: ordered)
        #expect(ordered[range].contains { $0.content.first?.text == "Both checked" })
        #expect(OpenClawChatHistoryPresentation.replyText(
            from: orderedRaw, runID: "legacy-run", submittedText: "Check both", submittedAtMs: 1) == "Both checked")

        let vm = Self.model()
        defer { vm.detachTransport() }
        for row in raw {
            try Self.deliver(row, to: vm)
        }
        #expect(vm.messages.map(\.role) == ["user", "assistant", "toolResult", "toolResult"])
        #expect(!OpenClawChatViewModel.hasUnansweredLatestUser(in: vm.messages))
        #expect(OpenClawChatViewModel.latestUserTurn(in: vm.messages)?.timestamp == 1)
    }

    @Test func `equal parallel output keeps both calls and distinct runs`() throws {
        let raw = try Self.raw(#"""
        {"role":"user","timestamp":3,"content":[
          {"type":"tool_result","tool_use_id":"a","content":"OK"},
          {"type":"tool_result","tool_use_id":"b","content":"OK"}
        ]}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([raw]).map(\.toolCallId) == ["a", "b"])
        let vm = Self.model()
        defer { vm.detachTransport() }
        try Self.deliver(raw, to: vm)
        #expect(vm.messages.map(\.toolCallId) == ["a", "b"])
        let runs = try Self.raw(#"""
        {"role":"user","timestamp":3,"__openclaw":{"id":"canonical-carrier"},"content":[
          {"type":"tool_result","tool_use_id":"a","runId":"run-a","content":"OK"},
          {"type":"tool_result","tool_use_id":"a","runId":"run-b","content":"OK"}
        ]}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([runs, runs]).map(\.transcriptRunID) == ["run-a", "run-b"])
        let runsVM = Self.model()
        defer { runsVM.detachTransport() }
        for _ in 0..<2 { try Self.deliver(runs, to: runsVM) }
        #expect(runsVM.messages.map(\.transcriptRunID) == ["run-a", "run-b"])
        #expect(runsVM.messages.map(\.transcriptMessageID) == ["canonical-carrier", "canonical-carrier"])

        let missingIDs = try Self.raw(#"""
        {"role":"user","timestamp":3,"__openclaw":{"id":"missing-call-ids"},"content":[
          {"type":"tool_result","content":"Alpha output"},
          {"type":"tool_result","content":"Beta output"}
        ]}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([missingIDs, missingIDs]).map { $0.content.first?.text }
            == ["Alpha output", "Beta output"])
        let missingVM = Self.model()
        defer { missingVM.detachTransport() }
        for _ in 0..<2 { try Self.deliver(missingIDs, to: missingVM) }
        #expect(missingVM.messages.map { $0.content.first?.text } == ["Alpha output", "Beta output"])

        let native = try Self.raw(#"{"role":"toolResult","timestamp":5,"content":"Native output"}"#)
        #expect(OpenClawChatViewModel.decodeMessages([native, native]).count == 1)
        let nativeVM = Self.model()
        defer { nativeVM.detachTransport() }
        for _ in 0..<2 {
            try Self.deliver(native, to: nativeVM)
        }
        #expect(nativeVM.messages.count == 1)
    }

    @Test func `session result carriers retain canonical tips for background branch reconciliation`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let carrierID = "opaque:tool-result:7"
        let raw = try Self.raw(Self.parallel.replacingOccurrences(of: "carrier", with: carrierID))
        let vm = OpenClawChatViewModel(
            sessionKey: "main", transport: ToolResultIngestionTransport(), outbox: store)
        defer { vm.detachTransport() }
        try Self.deliver(raw, to: vm)
        await vm.pendingCacheWriteTask?.value
        #expect(vm.messages.map(\.transcriptMessageID) == [carrierID, carrierID])
        let scope = try #require(vm.outboxBranchScope(for: vm.currentSessionSnapshot()))
        let state = try #require(await store.branchState(for: scope))
        #expect(state.lastActiveLeafEntryID == carrierID)
        #expect(await store.enqueueCommand(Self.command("background-after-results", scope: scope)))

        // Reconnect with another session visible: there is no visible ancestry
        // fallback, so the persisted tip must match the gateway's exact leaf.
        let reconnect = OpenClawChatViewModel(
            sessionKey: "other", transport: ToolResultIngestionTransport(), outbox: store)
        defer { reconnect.detachTransport() }
        #expect(await reconnect.reconcileOutboxBranchScope(
            scope, branches: [Self.branch(leaf: carrierID)], previousState: state))
        #expect(await store.loadCommands().map(\.status) == [.queued])
        #expect(await store.claimNextCommand()?.id == "background-after-results")
    }

    @Test func `history result carriers retain canonical cache tips and active-path ancestry`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let carrierID = "opaque:tool-result:7"
        let carrier = try Self.raw(Self.parallel.replacingOccurrences(of: "carrier", with: carrierID))
        let vm = OpenClawChatViewModel(
            sessionKey: "main", transport: ToolResultIngestionTransport(), transcriptCache: store, outbox: store)
        defer { vm.detachTransport() }
        #expect(vm.applyHistoryPayload(
            .init(sessionKey: "main", sessionId: nil, messages: [carrier], thinkingLevel: nil),
            for: vm.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false))
        await vm.pendingCacheWriteTask?.value
        let scope = try #require(vm.outboxBranchScope(for: vm.currentSessionSnapshot()))
        let state = try #require(await store.branchState(for: scope))
        #expect(state.lastActiveLeafEntryID == carrierID)
        #expect(await store.enqueueCommand(Self.command("queued-before-history-advances", scope: scope)))
        let descendant = try Self.raw(#"{"role":"assistant","__openclaw":{"id":"next-leaf"},"content":"Done"}"#)
        #expect(vm.applyHistoryPayload(
            .init(sessionKey: "main", sessionId: nil, messages: [carrier, descendant], thinkingLevel: nil),
            for: vm.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false))
        await vm.pendingCacheWriteTask?.value

        // Exercise the actual SQLite encode/decode path before branch ancestry
        // reads the expanded rows. Pending commands keep the captured tip pinned.
        let cached = await store.loadTranscript(sessionKey: "main", agentID: nil)
        #expect(cached.prefix(2).map(\.transcriptMessageID) == [carrierID, carrierID])
        #expect(cached.prefix(2).map(\.toolCallId) == ["a", "b"])
        #expect(cached.prefix(2).map { $0.content.first?.text } == ["Alpha output", "Beta output"])
        vm.replaceMessages(cached)
        #expect(await vm.reconcileOutboxBranchScope(
            scope, branches: [Self.branch(leaf: "next-leaf")], previousState: state))
        #expect(await store.loadCommands().map(\.status) == [.queued])
        #expect(await store.branchState(for: scope)?.lastActiveLeafEntryID == "next-leaf")
        #expect(await store.claimNextCommand()?.id == "queued-before-history-advances")
    }

    private static func branch(leaf: String) -> OpenClawChatSessionBranch {
        .init(leafEntryId: leaf, headline: "Current path", messageCount: 3, updatedAt: nil, active: true)
    }

    private static func command(_ id: String, scope: OpenClawChatOutboxScope) -> OpenClawChatOutboxCommand {
        .init(
            id: id,
            sessionKey: scope.sessionKey,
            agentID: scope.agentID,
            text: "Continue",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)
    }
}

private struct ToolResultIngestionTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: nil)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        .init(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}
