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
    {
      "role": "user",
      "timestamp": 3,
      "__openclaw": {
        "id": "carrier"
      },
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "a",
          "name": "exec",
          "content": "Alpha output"
        },
        {
          "type": "tool_result",
          "tool_use_id": "b",
          "name": "read",
          "content": [
            {
              "type": "text",
              "text": "Beta output"
            }
          ]
        }
      ]
    }
    """#
    private static let user = #"{"role":"user","timestamp":1,"content":"Check both"}"#
    private static let answer = #"{"role":"assistant","timestamp":4,"stopReason":"stop","content":"Both checked"}"#

    @Test func `parallel results`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(Self.parallel)])
        #expect(messages.map(\.role) == ["toolResult", "toolResult"])
        #expect(messages.map(\.toolCallId) == ["a", "b"])
        #expect(messages.map(\.toolName) == ["exec", "read"])
        #expect(messages.map { ChatMessageVisibleText.displayText(in: $0, includeThinking: false) } == [
            "Alpha output", "Beta output",
        ])
        #expect(Set(messages.compactMap(\.transcriptMessageID)).count == 2)
        let calls = try Self.raw(#"""
        {
          "role": "assistant",
          "timestamp": 2,
          "content": [
            {
              "type": "tool_use",
              "id": "a",
              "name": "exec",
              "arguments": {}
            },
            {
              "type": "tool_use",
              "id": "b",
              "name": "read",
              "arguments": {}
            }
          ]
        }
        """#)
        let merged = try ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages([
            Self.raw(Self.user), calls, Self.raw(Self.parallel), Self.raw(Self.answer),
        ]))
        #expect(merged.count == 3)
        let results = try #require(merged.first { $0.role == "assistant" }).content.filter(\.isToolResult)
        #expect(results.map(\.text) == ["Alpha output", "Beta output"])
        let rows = ChatTranscriptRow.build(from: merged)
        #expect(rows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(rows, runWorking: false).count == 3)
    }

    @Test func `mixed parallel results precede the next user turn`() throws {
        let calls = try Self.raw(#"""
        {"role":"assistant","timestamp":2,"content":[
          {"type":"tool_use","id":"a","name":"exec","arguments":{}},
          {"type":"tool_use","id":"b","name":"read","arguments":{}}
        ]}
        """#)
        let carrier = try Self.raw(#"""
        {"role":"user","timestamp":3,"content":[
          {"type":"tool_result","tool_use_id":"a","content":"Alpha output"},
          {"type":"tool_result","tool_use_id":"b","content":"Beta output"},
          {"type":"text","text":"Next instruction"}
        ]}
        """#)
        let decoded = OpenClawChatViewModel.decodeMessages([carrier])
        #expect(decoded.map(\.role) == ["toolResult", "toolResult", "user"])
        let merged = ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages([calls, carrier]))
        #expect(merged.map(\.role) == ["assistant", "user"])
        #expect(!merged.contains { $0.isToolResult })
        #expect(merged.first?.content.filter(\.isToolResult).map(\.text) == ["Alpha output", "Beta output"])
        let users = merged.filter { $0.role == "user" }
        #expect(users.count == 1)
        #expect(users.first?.content.count == 1)
        #expect(users.first?.content.first?.text == "Next instruction")
        #expect(ChatTranscriptRow.build(from: merged).filter(\.startsTurn).count == 1)

        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
        defer { vm.detachTransport() }
        for raw in [calls, carrier] {
            try vm.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main",
                message: GatewayPayloadDecoding.decode(raw, as: OpenClawChatMessage.self),
                messageId: nil,
                messageSeq: nil)))
        }
        #expect(vm.messages.map(\.role) == ["assistant", "toolResult", "toolResult", "user"])
        #expect(ChatTranscriptRow.mergeToolResults(in: vm.messages).map(\.role) == ["assistant", "user"])
        let turn = OpenClawChatViewModel.latestUserTurn(in: vm.messages)
        #expect(turn?.timestamp == 3)
        #expect(OpenClawChatViewModel.messageRange(after: turn, in: vm.messages).isEmpty)
        let answer = try Self.raw(#"""
        {"role":"assistant","timestamp":4,"stopReason":"stop","content":"Next answer"}
        """#)
        #expect(OpenClawChatHistoryPresentation.replyText(
            from: [calls, carrier, answer],
            runID: "legacy-run",
            submittedText: "Next instruction",
            submittedAtMs: 3) == "Next answer")
    }

    @Test func `mixed carrier results precede an adopted optimistic user`() throws {
        let calls = try Self.raw(#"""
        {"role":"assistant","timestamp":2,"content":[
          {"type":"tool_use","id":"a","name":"exec","arguments":{}},
          {"type":"tool_use","id":"b","name":"read","arguments":{}}
        ]}
        """#)
        let carrier = try Self.raw(#"""
        {"role":"user","timestamp":3,"idempotencyKey":"next:user","__openclaw":{"id":"mixed"},"content":[
          {"type":"tool_result","tool_use_id":"a","content":"Alpha output"},
          {"type":"tool_result","tool_use_id":"b","content":"Beta output"},
          {"type":"text","text":"Next instruction"}
        ]}
        """#)
        let optimistic = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Next instruction")],
            timestamp: 2.5,
            idempotencyKey: "next:user")
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
        defer { vm.detachTransport() }
        try vm.replaceMessages([GatewayPayloadDecoding.decode(calls, as: OpenClawChatMessage.self), optimistic])
        for _ in 0..<2 {
            try vm.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main",
                message: GatewayPayloadDecoding.decode(carrier, as: OpenClawChatMessage.self),
                messageId: nil,
                messageSeq: nil)))
            #expect(vm.messages.map(\.role) == ["assistant", "toolResult", "toolResult", "user"])
            #expect(vm.messages.last?.id == optimistic.id)
            #expect(vm.messages.last?.transcriptMessageID == "mixed")
            let merged = ChatTranscriptRow.mergeToolResults(in: vm.messages)
            #expect(merged.map(\.role) == ["assistant", "user"])
            #expect(!merged.contains { $0.isToolResult })
            #expect(merged.first?.content.filter(\.isToolResult).map(\.text) == ["Alpha output", "Beta output"])
            #expect(OpenClawChatViewModel.messageRange(
                after: OpenClawChatViewModel.latestUserTurn(in: vm.messages), in: vm.messages).isEmpty)
        }
    }

    @Test func `carrier turn boundary has one owner`() throws {
        let calls = try Self.raw(#"""
        {"role":"assistant","content":[
          {"type":"tool_use","id":"a","name":"exec","arguments":{}},
          {"type":"tool_use","id":"b","name":"read","arguments":{}}
        ]}
        """#)
        let pure = try Self.raw(#"""
        {"role":"user","__openclaw":{"turnBoundary":true},"content":[
          {"type":"tool_result","tool_use_id":"a","content":"Alpha output"},
          {"type":"tool_result","tool_use_id":"b","content":"Beta output"}
        ]}
        """#)
        let mixed = try Self.raw(#"""
        {"role":"user","__openclaw":{"turnBoundary":true},"content":[
          {"type":"tool_result","tool_use_id":"a","content":"Alpha output"},
          {"type":"tool_result","tool_use_id":"b","content":"Beta output"},
          {"type":"text","text":"Next instruction"}
        ]}
        """#)
        let pureMessages = OpenClawChatViewModel.decodeMessages([calls, pure])
        #expect(pureMessages.map(\.turnBoundary) == [nil, true, nil])
        let pureMerged = ChatTranscriptRow.mergeToolResults(in: pureMessages)
        // The real gateway boundary still prevents attachment across turns.
        #expect(pureMerged.map(\.role) == ["assistant", "toolResult", "toolResult"])
        #expect(pureMerged.first?.content.filter(\.isToolResult).isEmpty == true)
        let pureRows = ChatTranscriptRow.build(from: pureMerged)
        #expect(pureRows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(pureRows, runWorking: false)
            .filter(\.startsTurn).count == 1)

        let mixedMessages = OpenClawChatViewModel.decodeMessages([calls, mixed])
        #expect(mixedMessages.map(\.turnBoundary) == [nil, nil, nil, true])
        let mixedMerged = ChatTranscriptRow.mergeToolResults(in: mixedMessages)
        #expect(mixedMerged.map(\.role) == ["assistant", "user"])
        #expect(!mixedMerged.contains { $0.isToolResult })
        #expect(mixedMerged.first?.content.filter(\.isToolResult).map(\.text) == [
            "Alpha output", "Beta output",
        ])
        let mixedRows = ChatTranscriptRow.build(from: mixedMerged)
        #expect(mixedRows.filter(\.startsTurn).count == 1)
        #expect(ChatTranscriptRow.collapseCompletedWork(mixedRows, runWorking: false)
            .filter(\.startsTurn).count == 1)
    }

    @Test func `single result`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(
            #"""
            {
              "role": "user",
              "content": [
                {
                  "type": "tool_result",
                  "tool_use_id": "a",
                  "name": "exec",
                  "content": "Single output"
                }
              ]
            }
            """#)])
        let message = try #require(messages.first)
        #expect(message.role == "toolResult")
        #expect(message.toolCallId == "a")
        #expect(ChatMessageVisibleText.displayText(in: message, includeThinking: false) == "Single output")
    }

    @Test func `mixed content`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(
            #"""
            {
              "role": "user",
              "content": [
                {
                  "type": "text",
                  "text": "Actual user text"
                },
                {
                  "type": "tool_result",
                  "tool_use_id": "a",
                  "content": "Tool output"
                }
              ]
            }
            """#)])
        #expect(messages.map(\.role) == ["toolResult", "user"])
        #expect(messages.last?.content.count == 1)
        #expect(messages.last?.content.first?.text == "Actual user text")
        #expect(messages.first?.content.first?.text == "Tool output")
    }

    @Test func `unmatched result`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(Self.parallel)])
        let orphan = try #require(ChatTranscriptRow.mergeToolResults(in: messages).first)
        #expect(orphan.isToolResult)
        #expect(ChatTranscriptRow(orphan)?.startsTurn == false)
        #expect(ChatMessageVisibleText.displayText(in: orphan, includeThinking: false) == "Alpha output")
    }

    @Test func `error result preserves metadata`() throws {
        let activity = try JSONDecoder().decode([OpenClawChatHistoryActivity].self, from: Data(#"""
        [
          {
            "messageId": "carrier",
            "items": [
              {
                "itemId": "terminal-a",
                "toolCallId": "a",
                "kind": "tool",
                "phase": "end",
                "title": "Failed",
                "status": "error"
              },
              {
                "itemId": "terminal-b",
                "toolCallId": "b",
                "kind": "tool",
                "phase": "end",
                "title": "Done",
                "status": "ok"
              }
            ]
          }
        ]
        """#.utf8))
        let messages = try OpenClawChatViewModel.decodeMessages([Self.raw(
            #"""
            {
              "role": "user",
              "isError": true,
              "details": {
                "exitCode": 1
              },
              "__openclaw": {
                "id": "carrier",
                "runId": "run-a"
              },
              "content": [
                {
                  "type": "tool_result",
                  "tool_use_id": "a",
                  "name": "exec",
                  "is_error": true,
                  "content": [
                    {
                      "type": "text",
                      "text": "Command failed"
                    }
                  ]
                }
              ]
            }
            """#)], activity: activity)
        let message = try #require(messages.first)
        #expect(message.role == "toolResult")
        #expect(message.isError == true)
        #expect(message.details?.dictionaryValue?["exitCode"] == AnyCodable(1))
        #expect(message.activity?.map(\.itemId) == ["terminal-a"])
        #expect(message.transcriptRunID == "run-a")
        let call = try Self
            .raw(
                #"""
                {
                  "role": "assistant",
                  "__openclaw": {
                    "runId": "run-a"
                  },
                  "content": [
                    {
                      "type": "tool_use",
                      "id": "a",
                      "name": "exec",
                      "arguments": {}
                    }
                  ]
                }
                """#)
        let merged = ChatTranscriptRow.mergeToolResults(in: OpenClawChatViewModel.decodeMessages([call]) + messages)
        let result = try #require(merged.first?.content.last)
        #expect(result.text == "Command failed")
        #expect(result.isError == true)
        #expect(result.details == message.details)
        #expect(merged.first?.activity?.map(\.itemId) == ["terminal-a"])

        let sharedActivity = try JSONDecoder().decode([OpenClawChatHistoryActivity].self, from: Data(#"""
        [{"messageId":"carrier","items":[
          {"itemId":"terminal-a","toolCallId":"a","kind":"tool","phase":"end","title":"Done","status":"ok"},
          {"itemId":"terminal-b","toolCallId":"b","kind":"tool","phase":"end","title":"Done","status":"ok"},
          {"itemId":"carrier-status","kind":"tool","phase":"end","title":"Done","status":"ok"}
        ]}]
        """#.utf8))
        let parallelCalls = try Self.raw(#"""
        {"role":"assistant","content":[
          {"type":"tool_use","id":"a","name":"exec","arguments":{}},
          {"type":"tool_use","id":"b","name":"read","arguments":{}}
        ]}
        """#)
        let parallelMessages = try OpenClawChatViewModel.decodeMessages(
            [parallelCalls, Self.raw(Self.parallel)], activity: sharedActivity)
        let parallelMerged = ChatTranscriptRow.mergeToolResults(in: parallelMessages)
        #expect(parallelMerged.count == 1)
        #expect(parallelMerged.first?.activity?.map(\.itemId) == ["terminal-a", "terminal-b"])
    }

    @Test func `conflicting runs stay unmatched`() throws {
        let messages = try OpenClawChatViewModel.decodeMessages([
            Self
                .raw(
                    #"""
                    {
                      "role": "assistant",
                      "__openclaw": {
                        "runId": "run-a"
                      },
                      "content": [
                        {
                          "type": "tool_use",
                          "id": "a",
                          "name": "exec",
                          "arguments": {}
                        }
                      ]
                    }
                    """#),
            Self
                .raw(
                    #"""
                    {
                      "role": "assistant",
                      "__openclaw": {
                        "runId": "run-b"
                      },
                      "content": [
                        {
                          "type": "tool_use",
                          "id": "a",
                          "name": "exec",
                          "arguments": {}
                        }
                      ]
                    }
                    """#),
            Self
                .raw(
                    #"""
                    {
                      "role": "user",
                      "__openclaw": {
                        "runId": "run-a"
                      },
                      "content": [
                        {
                          "type": "tool_result",
                          "tool_use_id": "a",
                          "content": "A output"
                        }
                      ]
                    }
                    """#),
        ])
        let merged = ChatTranscriptRow.mergeToolResults(in: messages)
        #expect(merged.count == 3)
        #expect(merged.last?.role == "toolResult")
        #expect(merged.first?.content.count == 1)
        let legacy = try OpenClawChatViewModel.decodeMessages([
            Self.raw(#"""
            {"role":"assistant","__openclaw":{"runId":"run-b"},"content":[
              {"type":"tool_use","id":"a","name":"exec","arguments":{}}
            ]}
            """#),
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

    @Test func `latest user and legacy range ignore carriers`() throws {
        let raw = try [Self.user, Self.answer, Self.parallel].map(Self.raw)
        let messages = OpenClawChatViewModel.decodeMessages(raw)
        #expect(!OpenClawChatViewModel.hasUnansweredLatestUser(in: messages))
        #expect(OpenClawChatViewModel.latestUserTurn(in: messages)?.timestamp == 1)
        let before = try OpenClawChatViewModel.decodeMessages([Self.raw(Self.user)])
        let turn = OpenClawChatViewModel.latestUserTurn(in: before)
        let ordered = try OpenClawChatViewModel.decodeMessages([Self.user, Self.parallel, Self.answer].map(Self.raw))
        let range = OpenClawChatViewModel.messageRange(after: turn, in: ordered)
        #expect(ordered[range].contains { $0.content.first?.text == "Both checked" })
    }

    @Test func `voice fallback ignores carriers`() throws {
        let raw = try [Self.user, Self.parallel, Self.answer].map(Self.raw)
        #expect(OpenClawChatHistoryPresentation.replyText(
            from: raw, runID: "legacy-run", submittedText: "Check both", submittedAtMs: 1) == "Both checked")
    }

    @Test func `equal parallel output keeps both calls and distinct runs`() throws {
        let raw = try Self.raw(#"""
        {"role":"user","timestamp":3,"content":[
          {"type":"tool_result","tool_use_id":"a","content":"OK"},
          {"type":"tool_result","tool_use_id":"b","content":"OK"}
        ]}
        """#)
        let history = OpenClawChatViewModel.decodeMessages([raw])
        #expect(history.map(\.toolCallId) == ["a", "b"])
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
        defer { vm.detachTransport() }
        try vm.handleTransportEvent(.sessionMessage(.init(
            sessionKey: "main",
            message: GatewayPayloadDecoding.decode(raw, as: OpenClawChatMessage.self),
            messageId: nil,
            messageSeq: nil)))
        #expect(vm.messages.map(\.toolCallId) == ["a", "b"])
        let runs = try Self.raw(#"""
        {"role":"user","timestamp":3,"content":[
          {"type":"tool_result","tool_use_id":"a","runId":"run-a","content":"OK"},
          {"type":"tool_result","tool_use_id":"a","runId":"run-b","content":"OK"}
        ]}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([runs]).map(\.transcriptRunID) == ["run-a", "run-b"])

        let native = try Self.raw(#"""
        {"role":"toolResult","timestamp":5,"content":"Native output"}
        """#)
        #expect(OpenClawChatViewModel.decodeMessages([native, native]).count == 1)
        let nativeVM = OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
        defer { nativeVM.detachTransport() }
        for _ in 0..<2 {
            try nativeVM.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main",
                message: GatewayPayloadDecoding.decode(native, as: OpenClawChatMessage.self),
                messageId: nil,
                messageSeq: nil)))
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
        try vm.handleTransportEvent(.sessionMessage(.init(
            sessionKey: "main",
            message: GatewayPayloadDecoding.decode(raw, as: OpenClawChatMessage.self),
            messageId: nil,
            messageSeq: nil)))
        await vm.pendingCacheWriteTask?.value
        #expect(vm.messages.map(\.transcriptMessageID) == [
            carrierID + ":tool-result:0", carrierID + ":tool-result:1",
        ])
        let scope = try #require(vm.outboxBranchScope(for: vm.currentSessionSnapshot()))
        let state = try #require(await store.branchState(for: scope))
        #expect(state.lastActiveLeafEntryID == carrierID)
        #expect(await store.enqueueCommand(.init(
            id: "background-after-results", sessionKey: scope.sessionKey, agentID: scope.agentID,
            text: "Continue", thinking: "off", createdAt: Date().timeIntervalSince1970,
            status: .queued, retryCount: 0, lastError: nil)))

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
            for: vm.beginHistoryRequest(), preservingOptimisticLocalMessages: false))
        await vm.pendingCacheWriteTask?.value
        let scope = try #require(vm.outboxBranchScope(for: vm.currentSessionSnapshot()))
        let recorded = try #require(await store.branchState(for: scope))
        #expect(recorded.lastActiveLeafEntryID == carrierID)
        // Also cover an original gateway carrier tip recorded before expansion,
        // independently of this history request's tip projection.
        #expect(await store.updateLastActiveLeafEntryID(carrierID, expectedEpoch: recorded.epoch, for: scope))
        let state = try #require(await store.branchState(for: scope))
        #expect(await store.enqueueCommand(.init(
            id: "queued-before-history-advances", sessionKey: scope.sessionKey, agentID: scope.agentID,
            text: "Continue", thinking: "off", createdAt: Date().timeIntervalSince1970,
            status: .queued, retryCount: 0, lastError: nil)))
        let descendant = try Self.raw(#"{"role":"assistant","__openclaw":{"id":"next-leaf"},"content":"Done"}"#)
        #expect(vm.applyHistoryPayload(
            .init(sessionKey: "main", sessionId: nil, messages: [carrier, descendant], thinkingLevel: nil),
            for: vm.beginHistoryRequest(), preservingOptimisticLocalMessages: false))
        await vm.pendingCacheWriteTask?.value

        // Exercise the actual SQLite encode/decode path before branch ancestry
        // reads the expanded rows. Pending commands keep the captured tip pinned.
        let cached = await store.loadTranscript(sessionKey: "main", agentID: nil)
        #expect(cached.prefix(2).map(\.canonicalTranscriptMessageID) == [carrierID, carrierID])
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

    @Test @MainActor func `results ingestion stream keeps latest user`() throws {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ToolResultIngestionTransport())
        defer { vm.detachTransport() }
        for (index, json) in [
            #"{"role":"user","timestamp":1,"content":"Real prompt"}"#,
            #"{"role":"assistant","timestamp":2,"stopReason":"stop","content":"Real answer"}"#,
            #"""
            {
              "role": "user",
              "timestamp": 3,
              "content": [
                {
                  "type": "tool_result",
                  "tool_use_id": "a",
                  "content": "First output"
                },
                {
                  "type": "tool_result",
                  "tool_use_id": "b",
                  "content": "Second output"
                }
              ]
            }
            """#,
        ].enumerated() {
            let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
            vm.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main", message: message, messageId: "stream-\(index)", messageSeq: nil)))
        }
        #expect(vm.messages.map(\.role) == ["user", "assistant", "toolResult", "toolResult"])
        #expect(vm.messages.suffix(2).map(\.toolCallId) == ["a", "b"])
        #expect(!OpenClawChatViewModel.hasUnansweredLatestUser(in: vm.messages))
        #expect(OpenClawChatViewModel.latestUserTurn(in: vm.messages)?.timestamp == 1)
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
