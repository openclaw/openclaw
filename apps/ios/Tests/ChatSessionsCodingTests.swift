import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

struct ChatSessionsCodingTests {
    private struct ExecutorProbe: Decodable, Sendable {
        let decodedOnMainThread: Bool
        let mainActorRespondedDuringDecode: Bool

        init(from decoder: any Decoder) throws {
            _ = try decoder.singleValueContainer().decode(Int.self)
            self.decodedOnMainThread = Thread.isMainThread
            guard !self.decodedOnMainThread else {
                self.mainActorRespondedDuringDecode = false
                return
            }
            let responded = DispatchSemaphore(value: 0)
            Task { @MainActor in responded.signal() }
            // Bound failure without sleeping or polling. The decoder is still running
            // when MainActor acknowledges, so an inherited-actor task cannot pass.
            self.mainActorRespondedDuringDecode = responded.wait(timeout: .now() + 2) == .success
        }
    }

    @Test @MainActor func `RPC decoding leaves MainActor responsive during synchronous decode`() async throws {
        let probe = try await GatewayPayloadDecoding.decode(ExecutorProbe.self, from: Data("1".utf8))

        #expect(!probe.decodedOnMainThread)
        #expect(probe.mainActorRespondedDuringDecode)
    }

    @Test @MainActor func `cancelled RPC decoding does not detach from its caller`() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await GatewayPayloadDecoding.decode(ExecutorProbe.self, from: Data("1".utf8))
        }
        await #expect(throws: CancellationError.self) { try await task.value }
    }

    @Test func `decodes gateway model selection target from session defaults`() throws {
        let data = Data(#"""
        {
            "defaults": {
                "modelProvider": "openai",
                "model": "gpt-5.6-luna",
                "contextTokens": 200000,
                "modelSelectionTarget": "agent"
            },
            "sessions": []
        }
        """#.utf8)

        let response = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)

        #expect(response.defaults?.modelSelectionTarget == "agent")
    }

    @Test func `older gateway session defaults remain decodable without a target`() throws {
        let data = Data(#"""
        {
            "defaults": {
                "model": "gpt-5.6-luna",
                "contextTokens": 200000
            },
            "sessions": []
        }
        """#.utf8)

        let response = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)

        #expect(response.defaults?.modelSelectionTarget == nil)
    }

    @Test func `decodes session organization and read state fields`() throws {
        let data = Data(#"""
        {
            "key":"agent:main:telegram:group:1",
            "label":"Release room",
            "autoLabel":"Device fallback",
            "category":"Operations",
            "pinned":true,
            "archived":false,
            "unread":true,
            "lastReadAt":1720000000000,
            "markedUnreadAt":1720000002500,
            "lastActivityAt":1720000005000
        }
        """#.utf8)

        let entry = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)

        #expect(entry.label == "Release room")
        #expect(entry.autoLabel == "Device fallback")
        #expect(entry.category == "Operations")
        #expect(entry.pinned == true)
        #expect(entry.archived == false)
        #expect(entry.unread == true)
        #expect(entry.lastReadAt == 1_720_000_000_000)
        #expect(entry.markedUnreadAt == 1_720_000_002_500)
        #expect(entry.lastActivityAt == 1_720_000_005_000)
    }

    @Test @MainActor func `ios nested custom results preserve envelope and cached output`() throws {
        for (result, output, failed) in [
            (["content": [["type": "text", "text": "Nested success output"]]], "Nested success output", false),
            (["content": "Nested failure output", "isError": true], "Nested failure output", true),
            (["text": "Explicit output", "content": "Ignored output"], "Explicit output", false),
            (["content": [
                ["type": "text", "text": "Alpha"],
                ["type": "image", "width": "invalid"],
                ["type": "text", "text": "Beta"],
            ]], "Alpha\nBeta", false),
            (["content": ["malformed": true]], nil, false),
        ] as [([String: Any], String?, Bool)] {
            var envelope = Self.nestedEnvelope
            var blocks = try #require(envelope["content"] as? [[String: Any]])
            blocks[1].merge(result, uniquingKeysWith: { _, new in new })
            envelope["content"] = blocks
            let decoded = try GatewayPayloadDecoding.decode(Self.nestedRaw(envelope), as: OpenClawChatMessage.self)
            let messages = decoded.ingestedMessages
            let message = try #require(messages.first)
            #expect(messages.count == 1 && message.id == decoded.id && message.role == "custom")
            #expect(message.transcriptMessageID == "nested-row" && message.workRunID == "nested-run")
            let items = ChatToolActivity.items(message: message)
            let item = try #require(items.first)
            #expect(items.count == 1 && item.id == "nested-call" && item.name == "knowledge_status")
            #expect(item.arguments?.dictionaryValue?.isEmpty == true)
            #expect(item.details?.dictionaryValue?["marker"]?.stringValue == "paired")
            #expect(item.resultText == output && item.isError == failed && item.isVisible && !item.isPending)
            let cached = try JSONEncoder().encode(message)
            let fields = try #require(JSONSerialization.jsonObject(with: cached) as? [String: Any])
            #expect(fields["customType"] as? String == "openclaw.nested-tool.v1")
            let restored = try JSONDecoder().decode(OpenClawChatMessage.self, from: cached)
            #expect(restored.isNestedToolActivity && restored.role == "custom")
            #expect(restored.transcriptMessageID == "nested-row" && restored.workRunID == "nested-run")
            #expect(ChatToolActivity.items(message: restored) == items)
        }
    }

    @Test @MainActor func `ios sqlite cache preserves legacy text alongside nested output on reopen`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("nested-chat-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // Legacy payload-format compatibility, not an old-binary or schema migration.
        let legacyPayload = #"""
        {
            "role":"assistant",
            "content":[{"type":"text","text":"Previously cached answer"}],
            "timestamp":0,
            "__openclaw":{"id":"legacy-row","runId":"legacy-run"}
        }
        """#
        let legacy = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(legacyPayload.utf8))
        let seeded = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? seeded.close() }
        await seeded.store(gatewayID: "nested-cache").storeCanonicalTranscript(
            sessionKey: "main", agentID: nil, messages: [legacy], canonicalMessageIdempotencyKeys: [])
        // Seed the exact pre-change payload bytes using the existing cache-store test pattern.
        try await seeded.cacheQueue.write { db in
            try db.execute(
                sql: "UPDATE cached_messages SET payload_json = ? WHERE gateway_id = ? AND session_key = ?",
                arguments: [legacyPayload, "nested-cache", "main"])
        }
        try seeded.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        let store = reopened.store(gatewayID: "nested-cache")
        let existing = await store.loadTranscript(sessionKey: "main")
        let existingRow = try #require(existing.first)
        #expect(existing.count == 1 && existingRow.transcriptMessageID == "legacy-row")
        #expect(existingRow.role == "assistant" && !existingRow.isNestedToolActivity)
        #expect(existingRow.content.first?.text == "Previously cached answer")
        let nested = try #require(await OpenClawChatViewModel.decodeMessages([Self.nestedRaw(Self.nestedEnvelope)])
            .first)
        await store.storeCanonicalTranscript(
            sessionKey: "main", agentID: nil, messages: existing + [nested], canonicalMessageIdempotencyKeys: [])
        try reopened.close()

        let cold = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? cold.close() }
        let rows = await cold.store(gatewayID: "nested-cache").loadTranscript(sessionKey: "main")
        #expect(rows.map(\.transcriptMessageID) == ["legacy-row", "nested-row"])
        let plain = try #require(rows.first)
        #expect(plain.role == "assistant" && !plain.isNestedToolActivity && plain.workRunID == "legacy-run")
        #expect(plain.content.first?.text == "Previously cached answer")
        let restored = try #require(rows.last)
        #expect(restored.role == "custom" && restored.isNestedToolActivity && restored.workRunID == "nested-run")
        let items = ChatToolActivity.items(message: restored)
        let item = try #require(items.first)
        #expect(items.count == 1 && item.id == "nested-call" && item.name == "knowledge_status")
        #expect(item.resultText == "Nested success output")
        #expect(item.displayState == .finished && !item.isPending && !item.isError)
    }

    @Test @MainActor func `ios nested recognition is exact and ignores unrelated custom metadata`() async throws {
        for discriminator in [nil, "unknown", "Openclaw.nested-tool.v1", "openclaw.nested-tool.v1 ", 7] as [Any?] {
            var envelope = Self.nestedEnvelope
            envelope["customType"] = discriminator
            let messages = try await OpenClawChatViewModel.decodeMessages([Self.nestedRaw(envelope)])
            let message = try #require(messages.first)
            #expect(messages.count == 1 && message.role == "custom" && !message.isNestedToolActivity)
            #expect(ChatToolActivity.items(message: message).isEmpty)
            #expect(message.content.last?.text == nil)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
            #expect(encoded?["customType"] == nil)
        }
        for role in ["assistant", "system", "Custom", " custom"] {
            var envelope = Self.nestedEnvelope
            envelope["role"] = role
            let message = try #require(await OpenClawChatViewModel.decodeMessages([Self.nestedRaw(envelope)]).first)
            #expect(!message.isNestedToolActivity && message.role == role)
            #expect(ChatToolActivity.items(message: message).isEmpty == (role != "assistant"))
        }
    }

    @Test @MainActor func `ios nested activity keeps canonical visibility and outcome authority`() async throws {
        let decoded = try #require(await OpenClawChatViewModel.decodeMessages([Self.nestedRaw(Self.nestedEnvelope)])
            .first)
        for activity in [
            [],
            [Self.nestedActivity(callID: "other")],
            [Self.nestedActivity(hidden: true)],
            [Self.nestedActivity(suppressed: true)],
        ] {
            var message = decoded
            message.activity = activity
            let item = try #require(ChatToolActivity.items(message: message).first)
            #expect(!item.isVisible && item.activityPrepared && item.resultText == "Nested success output")
        }
        for (status, expected) in [
            ("skipped", ChatToolActivityItem.State.skipped),
            ("blocked", .blocked),
            (nil, .unavailable),
        ] as [(String?, ChatToolActivityItem.State)] {
            var envelope = Self.nestedEnvelope
            var blocks = try #require(envelope["content"] as? [[String: Any]])
            blocks[1]["isError"] = true
            envelope["content"] = blocks
            var message = try #require(await OpenClawChatViewModel.decodeMessages([Self.nestedRaw(envelope)]).first)
            message.activity = [Self.nestedActivity(status: status)]
            let item = try #require(ChatToolActivity.items(message: message).first)
            #expect(item.displayState == expected && !item.isError && !item.isPending)
            #expect(item.isVisible && item.resultText == "Nested success output")
        }
        var callOnly = decoded
        callOnly.content = Array(callOnly.content.prefix(1))
        let live = OpenClawChatPendingToolCall(
            toolCallId: "nested-call", name: "knowledge_status", args: nil, startedAt: 1, isError: nil)
        #expect(ChatToolActivity.items(message: callOnly).first?.displayState == .unavailable)
        let pending = try #require(ChatToolActivity.items(message: callOnly, liveTools: [live]).first)
        #expect(pending.isPending && pending.resultText == nil && pending.isVisible)
        let recorded = try #require(ChatToolActivity.items(message: decoded, liveTools: [live]).first)
        #expect(recorded.displayState == .finished && !recorded.isPending)
        #expect(recorded.resultText == "Nested success output")
    }

    @Test @MainActor func `ios nested live row adopts history without changing presentation identity`() async throws {
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { model.detachTransport() }
        var liveEnvelope = Self.nestedEnvelope
        liveEnvelope["__openclaw"] = ["id": "nested-row", "runId": "earlier-run"]
        liveEnvelope["content"] = try Array(#require(liveEnvelope["content"] as? [[String: Any]]).prefix(1))
        let live = try GatewayPayloadDecoding.decode(Self.nestedRaw(liveEnvelope), as: OpenClawChatMessage.self)
        for _ in 0..<2 {
            model.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main", message: live, messageId: "nested-row", messageSeq: 1)))
        }
        #expect(model.messages.count == 1)
        let before = try #require(model.messages.first)
        #expect(before.workRunID == "earlier-run")
        let payload = try JSONDecoder().decode(
            OpenClawChatHistoryPayload.self,
            from: JSONSerialization.data(withJSONObject: [
                "messages": [Self.nestedEnvelope], "sessionKey": "main",
                "activity": [["messageId": "nested-row", "items": JSONSerialization.jsonObject(with:
                    JSONEncoder().encode([Self.nestedActivity(status: "blocked")]))]],
            ]))
        let canonical = await OpenClawChatViewModel.decodeMessages(payload.messages ?? [], activity: payload.activity)
        let request = model.beginHistoryRequest()
        #expect(model.applyHistoryPayload(
            payload,
            for: request,
            preservingOptimisticLocalMessages: false,
            decodedMessages: canonical))
        let after = try #require(model.messages.first)
        #expect(model.messages.count == 1 && after.id == before.id && after.presentationID == before.presentationID)
        #expect(after.role == "custom" && after.workRunID == "nested-run" && after.isNestedToolActivity)
        #expect(ChatToolActivity.items(message: after).first?.resultText == "Nested success output")
        #expect(ChatToolActivity.items(message: after).first?.displayState == .blocked)
    }

    @Test @MainActor func `ios nested work shares one answered group with its outer call`() async throws {
        let prefix: [[String: Any]] = [
            ["role": "user", "content": "Check the file", "timestamp": 0, "__openclaw": ["id": "question"]],
            [
                "role": "assistant", "timestamp": 1,
                "__openclaw": ["id": "outer-row", "runId": "nested-run"],
                "content": [[
                    "type": "toolCall",
                    "id": "outer",
                    "name": "exec",
                    "arguments": ["command": "printf checked"],
                ]],
            ],
            [
                "role": "toolResult", "toolCallId": "outer", "toolName": "exec", "content": "Checked",
                "timestamp": 2, "__openclaw": ["id": "outer-result", "runId": "nested-run"],
            ],
        ]
        var nested = Self.nestedEnvelope
        nested["timestamp"] = 3
        var blocks = try #require(nested["content"] as? [[String: Any]])
        blocks[0]["name"] = "read"
        blocks[0]["arguments"] = ["path": "synthetic.txt"]
        blocks[1]["toolName"] = "read"
        nested["content"] = blocks
        let answer: [String: Any] = [
            "role": "assistant", "content": "The file is ready", "timestamp": 4, "phase": "final_answer",
            "__openclaw": ["id": "answer", "runId": "nested-run"],
        ]
        let decoded = try await OpenClawChatViewModel.decodeMessages((prefix + [nested, answer]).map(Self.nestedRaw))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        let rows = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        #expect(rows.count == 3)
        guard case let .message(question)? = rows.first,
              case let .completedWork(work)? = rows.dropFirst().first,
              case let .message(final)? = rows.last
        else {
            Issue.record("Expected one Worked group between the question and visible final answer")
            return
        }
        #expect(question.transcriptMessageID == "question" && final.transcriptMessageID == "answer")
        #expect(final.content.first?.text == "The file is ready" && final.isCompletedReply)
        #expect(work.messages.map(\.transcriptMessageID) == ["outer-row", "nested-row"])
        let items = work.messages.flatMap { ChatToolActivity.items(message: $0) }
        #expect(items.map(\.id) == ["outer", "nested-call"])
        #expect(items.map(\.resultText) == ["Checked", "Nested success output"])
        #expect(items.allSatisfy { !$0.isPending && $0.displayState == .finished })
        #expect(ChatCompletedWorkSummary.label(work: work, expanded: true) ==
            "Worked · 2 tool calls · 1 command · 1 read")
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: true) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(
            raw, runWorking: false, activeRunIDs: ["nested-run"]) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(Array(raw.dropLast()), runWorking: false) ==
            Array(raw.dropLast()))
    }

    static var nestedEnvelope: [String: Any] {
        [
            "role": "custom",
            "customType": "openclaw.nested-tool.v1",
            "display": true,
            "excludeFromContext": true,
            "__openclaw": ["id": "nested-row", "runId": "nested-run"],
            "timestamp": 1,
            "content": [
                [
                    "type": "toolCall",
                    "id": "nested-call",
                    "name": "knowledge_status",
                    "arguments": [:],
                    "parentToolCallId": "outer",
                    "runId": "nested-run",
                ],
                [
                    "type": "toolResult",
                    "role": "toolResult",
                    "toolCallId": "nested-call",
                    "toolName": "knowledge_status",
                    "parentToolCallId": "outer",
                    "runId": "nested-run",
                    "afterEntryId": "paragraph",
                    "isError": false,
                    "details": ["marker": "paired"],
                    "content": [["type": "text", "text": "Nested success output"]],
                ],
            ],
        ]
    }

    static func nestedRaw(_ fields: [String: Any]) throws -> AnyCodable {
        try JSONDecoder().decode(AnyCodable.self, from: JSONSerialization.data(withJSONObject: fields))
    }

    static func nestedActivity(
        callID: String = "nested-call",
        status: String? = "completed",
        phase: String = "end",
        hidden: Bool = false,
        suppressed: Bool = false) -> OpenClawAgentActivityItem
    {
        OpenClawAgentActivityItem(
            itemId: "tool:\(callID)",
            toolCallId: callID,
            kind: "tool",
            phase: phase,
            title: "Knowledge status",
            name: "knowledge_status",
            status: status,
            hideFromChannelProgress: hidden,
            suppressChannelProgress: suppressed)
    }
}
