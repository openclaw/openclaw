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
        var livePrefix = prefix
        livePrefix[0]["__openclaw"] = ["id": "question", "runId": "nested-run"]
        let live = try await OpenClawChatViewModel.decodeMessages((livePrefix + [nested]).map(Self.nestedRaw))
        let streaming = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: live))
        try #require(streaming.count == 3)
        let liveGroups = ChatAssistantRunGroup.build(
            streaming, liveRunID: "nested-run", hasLiveContent: true, searchActive: false)
        #expect(liveGroups.map(\.id) == [.row(streaming[0].id), .run("nested-run", streaming[0].id, 0)])
        let liveGroup = try #require(liveGroups.last)
        #expect(liveGroup.parts.map(\.id) == streaming.dropFirst().map { "row:\($0.id)" })
        #expect(liveGroup.runID == "nested-run" && liveGroup.includesLive)
        let cells = ChatAssistantListCell.cells(liveGroups[...])
        #expect(cells.map(\.id) == streaming.map { .row($0.id) } + [.live])
        #expect(cells.map(\.joinsAbove) == [false, false, true, true])
        #expect(cells.map(\.joinsBelow) == [false, true, true, false])

        for scope in ["wrong-run", "unknown-run", "custom", "boundary", "search"] {
            var isolated = nested
            if scope == "wrong-run" {
                isolated["__openclaw"] = ["id": "nested-row", "runId": "other"]
            } else if scope == "unknown-run" {
                isolated["__openclaw"] = ["id": "nested-row"]
            } else if scope == "custom" {
                isolated["customType"] = "unrelated"
            } else if scope == "boundary" {
                isolated["__openclaw"] = ["id": "nested-row", "runId": "nested-run", "turnBoundary": true]
            }
            let messages = try await OpenClawChatViewModel.decodeMessages((livePrefix + [isolated]).map(Self.nestedRaw))
            let isolatedRows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: messages))
            try #require(isolatedRows.count == 3)
            let groups = ChatAssistantRunGroup.build(
                isolatedRows, liveRunID: "nested-run", hasLiveContent: true, searchActive: scope == "search")
            #expect(groups.count == (["boundary", "search"].contains(scope) ? 4 : 3))
            #expect(groups[1].parts.map(\.id) == ["row:\(isolatedRows[1].id)"])
            #expect(groups[2].id == .row(isolatedRows[2].id) && groups[2].runID == nil)
            #expect(!groups[2].includesLive)
            #expect(groups.flatMap(\.parts).map(\.id) == isolatedRows.map { "row:\($0.id)" })
            if scope == "search" { #expect(groups.allSatisfy { $0.runID == nil }) }
        }

        var followup = prefix[0]
        followup["__openclaw"] = ["id": "followup", "runId": "next-run"]
        followup["timestamp"] = 2.5
        let late = try await OpenClawChatViewModel.decodeMessages((livePrefix + [followup, nested]).map(Self.nestedRaw))
        let lateRows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: late))
        try #require(lateRows.count == 4)
        let lateGroups = ChatAssistantRunGroup.build(
            lateRows, liveRunID: "nested-run", hasLiveContent: true, searchActive: false)
        #expect(lateGroups.map(\.id) == [
            .row(lateRows[0].id), .run("nested-run", lateRows[0].id, 0),
            .row(lateRows[2].id), .run("nested-run", lateRows[0].id, 1),
        ])
        #expect(lateGroups.last?.parts.map(\.id) == ["row:\(lateRows[3].id)"])
        #expect(lateGroups.filter(\.includesLive).map(\.id) == [.run("nested-run", lateRows[0].id, 1)])
        #expect(ChatAssistantListCell.cells(lateGroups[...]).map(\.id) == lateRows.map { .row($0.id) } + [.live])

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
        #expect(ChatCompletedWorkSummary.activityHeadline(work.messages) == "Ran commands, read files")
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: true) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(
            raw, runWorking: false, activeRunIDs: ["nested-run"]) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(Array(raw.dropLast()), runWorking: false) ==
            Array(raw.dropLast()))
    }

    @Test(arguments: [
        "same", "foreign", "missing-source", "missing-turn", "unowned", "input-only", "final-only", "reply-only",
        "steer-local", "steer-foreign",
        "foreign-final", "foreign-final-first", "foreign-final-last", "steer-foreign-final",
        "foreign-ordinary", "foreign-ordinary-after", "foreign-result", "legacy-result",
        "foreign-mixed-after", "foreign-empty-after",
        "post-final-owned", "post-final-foreign",
        "post-final-missing", "post-final-unresolved", "post-final-commentary",
    ])
    @MainActor func `ios idle collapse keeps nested ownership and interleaving order`(scope: String) async throws {
        let isSteer = scope.hasPrefix("steer-")
        let isTail = scope.hasPrefix("post-final-")
        let foldsNested = [
            "same", "input-only", "final-only", "reply-only", "steer-local",
            "foreign-final-first", "foreign-final-last", "foreign-ordinary-after", "post-final-owned",
            "foreign-mixed-after", "foreign-empty-after",
        ].contains(scope)
        let wire = try Self.idleWorkWire(scope: scope)
        let decoded = try await OpenClawChatViewModel.decodeMessages(wire.map(Self.nestedRaw))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        if ["foreign", "steer-local"].contains(scope) {
            #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: true) == raw)
            #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false, activeRunIDs: ["run-b"]) == raw)
            #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false, searchActive: true) == raw)
        }
        let settled = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        let groups = settled.compactMap { row -> ChatTranscriptRow.CompletedWork? in
            if case let .completedWork(work) = row { return work }
            return nil
        }
        if ["foreign-final", "steer-foreign-final"].contains(scope) {
            #expect(groups.isEmpty && settled == raw)
            return
        }
        if ["foreign-mixed-after", "foreign-empty-after"].contains(scope) {
            let original = try #require(raw.first { row in
                if case let .message(message) = row { return message.transcriptMessageID == "a-work" }
                return false
            })
            #expect(settled.filter { $0.id == original.id } == [original])
        }
        let secondWork = try #require(groups.first { $0.messages.contains { $0.transcriptMessageID == "b-work" } })
        let sharesWork = foldsNested && !isSteer && !isTail
        #expect(secondWork.messages.map(\.transcriptMessageID) ==
            (scope == "legacy-result" ? ["b-work", "a-result"] : sharesWork ? ["b-work", "nested-row"] : ["b-work"]))
        #expect(secondWork.messages.flatMap { ChatToolActivity.items(message: $0) }.map(\.id) ==
            (scope == "legacy-result" ? ["b-exec", "a-call"] : sharesWork ? ["b-exec", "nested-call"] : ["b-exec"]))
        #expect(groups.count == (["steer-local", "post-final-owned"].contains(scope) ? 2 : 1))
        if scope == "steer-local" { #expect(groups.first?.messages.map(\.transcriptMessageID) == ["nested-row"]) }
        if scope == "post-final-owned" { #expect(groups.last?.messages.map(\.transcriptMessageID) == ["nested-row"]) }
        let order = settled.compactMap { row -> String? in
            switch row {
            case let .message(message): message.transcriptMessageID
            case .completedWork: "Worked"
            default: nil
            }
        }
        var expected = isSteer ? ["a-input", foldsNested ? "Worked" : "nested-row", "b-input", "Worked", "b-answer"] :
            ["a-input", "a-answer", "b-input", "Worked"] + (foldsNested ? [] : ["nested-row"]) + ["b-answer"]
        if scope == "reply-only" { expected.insert("b-progress", at: 3) }
        if scope == "foreign-final-first" { expected.insert("foreign-answer", at: expected.count - 1) }
        if scope == "foreign-final-last" { expected.append("foreign-answer") }
        if ["foreign-ordinary", "foreign-ordinary-after", "foreign-mixed-after", "foreign-empty-after"]
            .contains(scope)
        {
            expected.insert("a-work", at: 4)
        }
        if scope == "foreign-result" { expected.insert("a-result", at: 4) }
        if isTail {
            expected = ["a-input", "a-answer", "b-input", "Worked", "b-answer"] +
                (scope == "post-final-commentary" ? ["tail-commentary"] : []) +
                [foldsNested ? "Worked" : "nested-row"]
        }
        #expect(order == expected)
        #expect(order.filter { $0 == "nested-row" }.count == (foldsNested ? 0 : 1))
        #expect(ChatTranscriptRow.collapseCompletedWork(settled, runWorking: false) == settled)
        let frames = ChatAssistantRunGroup.build(settled, liveRunID: nil, hasLiveContent: false, searchActive: false)
        #expect(ChatAssistantListCell.cells(frames[...]).map(\.id) == settled.map { .row($0.id) })
    }

    @Test(arguments: ["late", "early", "only", "unknown", "reuse", "steer", "steer-only"])
    @MainActor func `ios untagged idle work does not inherit an earlier inputs delayed final`(
        scope: String) async throws
    {
        let base = try Self.idleWorkWire(scope: "same")
        var prefix = Array(base.prefix(2))
        var current = Array(base.suffix(4))
        current[0]["__openclaw"] = ["id": "b-input"]
        var foreign = base[1]
        foreign["__openclaw"] = ["id": "foreign-answer", "runId": "run-a"]
        foreign["timestamp"] = 6
        if ["reuse", "steer"].contains(scope) {
            for index in 1...3 {
                var metadata = try #require(current[index]["__openclaw"] as? [String: Any])
                metadata["runId"] = "run-a"
                current[index]["__openclaw"] = metadata
            }
            current[0]["__openclaw"] = scope == "reuse" ? ["id": "b-input", "runId": "run-a"] :
                ["id": "b-input", "steerTargetRunId": "run-a"]
            if scope == "steer" {
                var earlier = current[2]
                earlier["__openclaw"] = ["id": "earlier-nested", "runId": "run-a"]
                earlier["timestamp"] = 1
                prefix = [base[0], earlier]
            }
        }
        if scope == "steer-only" {
            var predecessor = base[2]
            predecessor["__openclaw"] = ["id": "p-input", "runId": "run-p", "steerTargetRunId": "run-a"]
            var earlier = base[4]
            earlier["__openclaw"] = ["id": "earlier-nested", "runId": "run-p"]
            prefix += [predecessor, earlier]
            current[0]["__openclaw"] = ["id": "b-input", "steerTargetRunId": "run-p"]
        }
        let hasNoLocalFinal = ["only", "steer-only"].contains(scope)
        if hasNoLocalFinal {
            current.removeLast()
            current[1]["__openclaw"] = ["id": "b-work"]
        }
        if scope == "unknown" {
            current.removeLast()
            foreign["__openclaw"] = ["id": "foreign-answer"]
        }
        var wire = prefix + current
        if scope != "steer" { wire.insert(foreign, at: scope == "early" ? wire.count - 1 : wire.count) }
        let decoded = try await OpenClawChatViewModel.decodeMessages(wire.map(Self.nestedRaw))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        let settled = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        if hasNoLocalFinal {
            #expect(settled == raw)
            return
        }
        let work = settled.compactMap { row -> [String]? in
            if case let .completedWork(work) = row { return work.messages.compactMap(\.transcriptMessageID) }
            return nil
        }
        #expect(work == (scope == "steer" ? [["earlier-nested"], ["b-work", "nested-row"]] :
                scope == "unknown" ? [["b-work"]] : [["b-work", "nested-row"]]))
        let order = settled.map { row -> String in
            switch row {
            case let .message(message): message.transcriptMessageID ?? "missing-id"
            case .completedWork: "Worked"
            default: "unexpected"
            }
        }
        let expected = switch scope {
        case "steer": ["a-input", "Worked", "b-input", "Worked", "b-answer"]
        case "unknown": ["a-input", "a-answer", "b-input", "Worked", "nested-row", "foreign-answer"]
        case "early": ["a-input", "a-answer", "b-input", "Worked", "foreign-answer", "b-answer"]
        default: ["a-input", "a-answer", "b-input", "Worked", "b-answer", "foreign-answer"]
        }
        #expect(order == expected)
        #expect(ChatTranscriptRow.collapseCompletedWork(settled, runWorking: false) == settled)
    }

    @Test(arguments: [
        "backed", "explicit", "untagged", "invalid",
        "suffix", "suffix-loaded", "suffix-explicit", "suffix-untagged", "suffix-no-hint",
        "suffix-mismatch", "suffix-no-final", "suffix-unsupported", "suffix-mixed",
    ])
    @MainActor func `ios backed steer request key is not its consuming run identity`(scope: String) async throws {
        let base = try Self.idleWorkWire(scope: "same")
        var earlier = base[4]
        earlier["__openclaw"] = ["id": "earlier-nested", "runId": "run-a"]
        earlier["timestamp"] = 1
        let isSuffix = scope.hasPrefix("suffix")
        var prefix = isSuffix ? [] : [base[0], earlier]
        if scope == "suffix-loaded" {
            var input = base[0]
            input["__openclaw"] = ["id": "a-input"]
            var progress = base[1]
            progress["__openclaw"] = ["id": "a-progress", "runId": "run-a"]
            progress["phase"] = "commentary"
            prefix = [input, progress, earlier]
        }
        var current = Array(base.suffix(4))
        let hasExplicitRun = ["explicit", "suffix-explicit"].contains(scope)
        let outputRun = ["explicit", "untagged", "suffix-explicit", "suffix-no-hint", "suffix-mismatch"]
            .contains(scope) ? "run-b" : "run-a"
        let target: String? = scope == "suffix-no-hint" ? nil : scope == "invalid" ? "run-absent" : "run-a"
        var inputMetadata = ["id": "b-input"]
        if let target { inputMetadata["steerTargetRunId"] = target }
        if hasExplicitRun { inputMetadata["runId"] = outputRun }
        current[0]["__openclaw"] = inputMetadata
        // chat-send-steering-custody emits a request key independently of the backing target.
        let hasRequestKey = !["untagged", "suffix-untagged", "suffix-no-hint"].contains(scope)
        if hasRequestKey { current[0]["idempotencyKey"] = "steer:user" }
        for index in 1...3 {
            var metadata = try #require(current[index]["__openclaw"] as? [String: Any])
            metadata["runId"] = outputRun
            current[index]["__openclaw"] = metadata
        }
        if scope == "suffix-no-final" { current[3]["phase"] = "commentary" }
        if scope == "suffix-unsupported" { current[3]["__openclaw"] = ["id": "b-answer"] }
        if scope == "suffix-mixed" {
            var other = base[1]
            other["__openclaw"] = ["id": "foreign-progress", "runId": "run-b"]
            other["phase"] = "commentary"
            other["timestamp"] = 2.5
            current.insert(other, at: 1)
        }
        // A corroborated target with its input outside this window is indistinguishable from a valid suffix.
        // The invalid control therefore uses a genuinely mismatched target, not merely a missing predecessor.
        let decoded = try await OpenClawChatViewModel.decodeMessages((prefix + current).map(Self.nestedRaw))
        let input = try #require(decoded.first { $0.transcriptMessageID == "b-input" })
        #expect(input.idempotencyKey == (hasRequestKey ? "steer:user" : nil))
        #expect(input.steerTargetRunID == target)
        #expect(input.transcriptRunID == (hasExplicitRun ? "run-b" : nil))
        #expect(input.workRunID == (hasExplicitRun ? "run-b" : hasRequestKey ? "steer" : nil))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: true) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false, activeRunIDs: [outputRun]) == raw)
        #expect(ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false, searchActive: true) == raw)
        let settled = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        if ["invalid", "suffix-mismatch", "suffix-no-final", "suffix-unsupported"].contains(scope) {
            #expect(settled == raw)
            return
        }
        let work = settled.compactMap { row -> [String]? in
            if case let .completedWork(work) = row { return work.messages.compactMap(\.transcriptMessageID) }
            return nil
        }
        #expect(work == (isSuffix ? [["b-work", "nested-row"]] : [["earlier-nested"], ["b-work", "nested-row"]]))
        if scope == "suffix-loaded" { #expect(Array(settled.prefix(prefix.count)) == Array(raw.prefix(prefix.count))) }
        let prefixIDs = scope == "suffix-loaded" ? ["a-input", "a-progress", "earlier-nested"] :
            isSuffix ? [] : ["a-input", "Worked"]
        #expect(settled.map { row -> String in
            if case let .message(message) = row { return message.transcriptMessageID ?? "missing-id" }
            return "Worked"
        } == prefixIDs + ["b-input"] + (scope == "suffix-mixed" ? ["foreign-progress"] : []) + ["Worked", "b-answer"])
        #expect(ChatTranscriptRow.collapseCompletedWork(settled, runWorking: false) == settled)
    }

    @Test(arguments: [
        "one", "several", "missing", "foreign", "unresolved",
        "unknown-result", "legacy-final", "commentary", "ordinary", "structural", "custom",
        "polluted-ordinary", "polluted-commentary", "polluted-final", "polluted-unknown",
    ])
    @MainActor func `ios owned nested tail can follow visible foreign finals without crossing other barriers`(
        scope: String) async throws
    {
        let base = try Self.idleWorkWire(scope: "same")
        var wire = [base[0], base[1], base[2], base[3], base[5]]
        let hasForeignPrefix = scope.hasPrefix("polluted-")
        if hasForeignPrefix {
            var narration = base[1]
            narration["__openclaw"] = ["id": "foreign-prefix", "runId": "run-a"]
            narration["phase"] = "commentary"
            wire.insert(narration, at: 4)
        }
        let foreignIDs = scope == "several" ? ["foreign-0", "foreign-1", "foreign-2"] : ["foreign-0"]
        for (index, id) in foreignIDs.enumerated() {
            var foreign = scope == "polluted-ordinary" ? base[3] : base[1]
            foreign["__openclaw"] = ["id": id, "runId": index == 1 ? "run-c" : "run-a"]
            if ["polluted-commentary", "polluted-unknown"].contains(scope) { foreign["phase"] = "commentary" }
            if scope == "polluted-unknown" { foreign["__openclaw"] = ["id": id] }
            foreign["timestamp"] = 5.1 + Double(index) / 10
            wire.append(foreign)
        }
        var barrier: [String: Any]?
        switch scope {
        case "legacy-final", "commentary":
            var reply = base[1]
            reply["__openclaw"] = scope == "legacy-final" ? ["id": "barrier"] :
                ["id": "barrier", "runId": "run-b"]
            reply["phase"] = scope == "commentary" ? "commentary" : "final_answer"
            barrier = reply
        case "ordinary", "unknown-result":
            barrier = [
                "role": "toolResult", "toolCallId": "tail-call", "toolName": "read", "content": "Tail result",
                "__openclaw": scope == "ordinary" ? ["id": "barrier", "runId": "run-b"] : ["id": "barrier"],
            ]
        case "structural":
            barrier = ["role": "system", "content": [], "__openclaw": ["kind": "compaction"]]
        case "custom":
            barrier = [
                "role": "custom",
                "customType": "unrelated",
                "content": "Visible custom",
                "__openclaw": ["id": "barrier", "runId": "run-b"],
            ]
        default: break
        }
        if let barrier { wire.append(barrier) }
        var nested = base[4]
        nested["timestamp"] = 7
        if scope == "missing" { nested["__openclaw"] = ["id": "nested-row"] }
        if scope == "foreign" { nested["__openclaw"] = ["id": "nested-row", "runId": "run-c"] }
        if scope == "unresolved" {
            nested["content"] = try Array(#require(nested["content"] as? [[String: Any]]).prefix(1))
        }
        wire.append(nested)
        let decoded = try await OpenClawChatViewModel.decodeMessages(wire.map(Self.nestedRaw))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        let settled = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        let foldsTail = ["one", "several", "legacy-final", "polluted-final", "polluted-unknown"].contains(scope)
        let work = settled.compactMap { row -> [String]? in
            if case let .completedWork(work) = row { return work.messages.compactMap(\.transcriptMessageID) }
            return nil
        }
        #expect(work == (foldsTail ? [["b-work"], ["nested-row"]] : [["b-work"]]))
        let order = settled.map { row -> String in
            switch row {
            case let .message(message): message.transcriptMessageID ?? "missing-id"
            case .completedWork: "Worked"
            case .historyDivider: "divider"
            default: "unexpected"
            }
        }
        #expect(order == ["a-input", "a-answer", "b-input", "Worked"] +
            (hasForeignPrefix ? ["foreign-prefix"] : []) + ["b-answer"] + foreignIDs +
            (barrier == nil ? [] : [scope == "structural" ? "divider" : "barrier"]) +
            [foldsTail ? "Worked" : "nested-row"])
        for message in decoded where message.transcriptMessageID?.hasPrefix("foreign-") == true {
            #expect(settled.contains(.message(message)))
        }
        #expect(ChatTranscriptRow.collapseCompletedWork(settled, runWorking: false) == settled)
    }

    private static func idleWorkWire(scope: String) throws -> [[String: Any]] {
        let isSteer = scope.hasPrefix("steer-")
        let isTail = scope.hasPrefix("post-final-")
        let foreignFinal = scope.contains("foreign-final")
        let first: [String: Any] = [
            "role": "user", "content": "First request", "timestamp": 0,
            "__openclaw": ["id": "a-input", "runId": "run-a"],
        ]
        let firstAnswer: [String: Any] = [
            "role": "assistant", "content": "First answer", "timestamp": 1, "phase": "final_answer",
            "__openclaw": ["id": "a-answer", "runId": "run-a"],
        ]
        var inputMetadata: [String: Any] = ["id": "b-input"]
        if !["missing-turn", "unowned", "final-only", "reply-only"].contains(scope) {
            inputMetadata["runId"] = "run-b"
        }
        if isSteer { inputMetadata["steerTargetRunId"] = "run-a" }
        let second: [String: Any] = [
            "role": "user", "content": "Second request", "timestamp": 2, "__openclaw": inputMetadata,
        ]
        let work: [String: Any] = [
            "role": "assistant", "timestamp": 3, "__openclaw": ["id": "b-work", "runId": "run-b"],
            "content": [
                ["type": "toolCall", "id": "b-exec", "name": "exec", "arguments": ["command": "printf done"]],
                ["type": "tool_result", "id": "b-exec", "name": "exec", "text": "Done"],
            ],
        ]
        var nested = Self.nestedEnvelope
        var nestedMetadata: [String: Any] = ["id": "nested-row"]
        if !["missing-source", "unowned", "post-final-missing"].contains(scope) {
            nestedMetadata["runId"] = [
                "foreign", "steer-local", "steer-foreign-final", "foreign-ordinary", "foreign-result",
                "legacy-result", "post-final-foreign",
            ].contains(scope) ? "run-a" : "run-b"
        }
        nested["__openclaw"] = nestedMetadata
        nested["timestamp"] = isSteer ? 1 : (isTail ? 6 : 4)
        if scope == "post-final-unresolved" {
            nested["content"] = try Array(#require(nested["content"] as? [[String: Any]]).prefix(1))
        }
        var finalMetadata: [String: Any] = ["id": foreignFinal ? "foreign-answer" : "b-answer"]
        if !isTail, !["missing-turn", "unowned", "input-only", "reply-only"].contains(scope) {
            finalMetadata["runId"] = foreignFinal ? "run-a" : "run-b"
        }
        let final: [String: Any] = [
            "role": "assistant", "content": "Second answer", "timestamp": 5, "phase": "final_answer",
            "__openclaw": finalMetadata,
        ]
        var wire = isSteer ? [first, nested, second, work, final] : [first, firstAnswer, second, work, nested, final]
        if isTail { wire = [first, firstAnswer, second, work, final, nested] }
        if ["foreign-final-first", "foreign-final-last"].contains(scope) {
            var ownFinal = final
            ownFinal["__openclaw"] = ["id": "b-answer", "runId": "run-b"]
            wire.insert(ownFinal, at: scope == "foreign-final-first" ? wire.count : wire.count - 1)
        }
        if [
            "foreign-ordinary", "foreign-ordinary-after", "foreign-result", "legacy-result",
            "foreign-mixed-after", "foreign-empty-after",
        ].contains(scope) {
            var other = work
            other["__openclaw"] = ["id": "a-work", "runId": "run-a"]
            if scope == "foreign-mixed-after" {
                var content = try #require(work["content"] as? [[String: Any]])
                content.insert(["type": "text", "text": "Foreign narration"], at: 0)
                other["content"] = content
            } else if scope == "foreign-empty-after" {
                other["content"] = []
            } else if !["foreign-ordinary", "foreign-ordinary-after"].contains(scope) {
                other = [
                    "role": "toolResult", "toolCallId": "a-call", "toolName": "read", "content": "Other result",
                    "timestamp": 3.5, "__openclaw": scope == "legacy-result" ? ["id": "a-result"] :
                        ["id": "a-result", "runId": "run-a"],
                ]
            }
            wire.insert(other, at: scope.hasSuffix("-after") ? 5 : 4)
        }
        if scope == "post-final-commentary" {
            wire.insert([
                "role": "assistant", "content": "Another check", "phase": "commentary", "timestamp": 5.5,
                "__openclaw": ["id": "tail-commentary", "runId": "run-b"],
            ], at: wire.count - 1)
        }
        if scope == "reply-only" {
            wire.insert([
                "role": "assistant", "content": "Checking", "phase": "commentary", "timestamp": 2.5,
                "__openclaw": ["id": "b-progress", "runId": "run-b"],
            ], at: 3)
        }
        return wire
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

extension ChatSessionsCodingTests {
    @Test(arguments: [
        "inferred-final", "inferred-commentary", "ordinary-final", "inferred-only",
        "ambiguous-earlier", "ordinary-ambiguous", "nested-only-earlier", "unknown-earlier",
        "unscoped-earlier", "known-current",
    ])
    @MainActor func `ios earlier reply ownership fences later work without remembering ambiguous guesses`(
        scope: String) async throws
    {
        let base = try Self.idleWorkWire(scope: "same")
        var first = base[0]
        first["__openclaw"] = ["id": "a-input"]
        var earlier = base[4]
        earlier["__openclaw"] = ["id": "earlier-nested", "runId": "run-a"]
        earlier["timestamp"] = 0.75
        var answer = base[1]
        var prefix = scope == "unscoped-earlier" ? [] : [first]
        if ["ambiguous-earlier", "ordinary-ambiguous", "known-current"].contains(scope) {
            var conflicting = answer
            conflicting["__openclaw"] = ["id": "a-progress", "runId": "run-c"]
            conflicting["phase"] = "commentary"
            conflicting["timestamp"] = 0.5
            prefix.append(conflicting)
        }
        if scope == "inferred-commentary" {
            answer["__openclaw"] = ["id": "a-progress", "runId": "run-a"]
            answer["phase"] = "commentary"
            answer["timestamp"] = 0.5
            prefix.append(answer)
        }
        if !["ordinary-final", "ordinary-ambiguous"].contains(scope) { prefix.append(earlier) }
        if scope == "unknown-earlier" { answer["__openclaw"] = ["id": "a-answer"] }
        if !["nested-only-earlier", "inferred-commentary"].contains(scope) { prefix.append(answer) }
        let reusesInferredRun = [
            "ambiguous-earlier", "ordinary-ambiguous", "nested-only-earlier", "unknown-earlier", "unscoped-earlier",
        ].contains(scope)
        var current = Array(base.suffix(4))
        current[0]["__openclaw"] = scope == "known-current" ? ["id": "b-input", "runId": "run-b"] : ["id": "b-input"]
        if reusesInferredRun {
            for index in 1...3 {
                var metadata = try #require(current[index]["__openclaw"] as? [String: Any])
                metadata["runId"] = "run-a"
                current[index]["__openclaw"] = metadata
            }
        }
        let hasNoLocalFinal = scope == "inferred-only"
        if hasNoLocalFinal {
            current.removeLast()
            current[1]["__openclaw"] = ["id": "b-work"]
        }
        if scope == "inferred-final" {
            var foreignNested = earlier
            foreignNested["__openclaw"] = ["id": "foreign-nested", "runId": "run-a"]
            foreignNested["timestamp"] = 4.5
            current.insert(foreignNested, at: 3)
        }
        if !reusesInferredRun {
            var foreign = base[1]
            foreign["__openclaw"] = ["id": "foreign-answer", "runId": "run-a"]
            foreign["timestamp"] = 6
            current.append(foreign)
        }
        let decoded = try await OpenClawChatViewModel.decodeMessages((prefix + current).map(Self.nestedRaw))
        let raw = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: decoded))
        let settled = ChatTranscriptRow.collapseCompletedWork(raw, runWorking: false)
        let foldsEarlier = ["inferred-final", "inferred-only", "ambiguous-earlier", "unscoped-earlier", "known-current"]
            .contains(scope)
        let work = settled.compactMap { row -> [String]? in
            if case let .completedWork(work) = row { return work.messages.compactMap(\.transcriptMessageID) }
            return nil
        }
        #expect(work == (foldsEarlier ? [["earlier-nested"]] : []) +
            (hasNoLocalFinal ? [] : [["b-work", "nested-row"]]))
        let prefixIDs = [
            "inferred-commentary": ["a-input", "a-progress", "earlier-nested"],
            "ordinary-final": ["a-input", "a-answer"],
            "ordinary-ambiguous": ["a-input", "a-progress", "a-answer"],
            "ambiguous-earlier": ["a-input", "a-progress", "Worked", "a-answer"],
            "known-current": ["a-input", "a-progress", "Worked", "a-answer"],
            "nested-only-earlier": ["a-input", "earlier-nested"],
            "unknown-earlier": ["a-input", "earlier-nested", "a-answer"],
            "unscoped-earlier": ["Worked", "a-answer"],
        ][scope] ?? ["a-input", "Worked", "a-answer"]
        let currentIDs = hasNoLocalFinal ? ["b-work", "nested-row"] :
            ["Worked"] + (scope == "inferred-final" ? ["foreign-nested"] : []) + ["b-answer"]
        #expect(settled.map { row -> String in
            if case let .message(message) = row { return message.transcriptMessageID ?? "missing-id" }
            return "Worked"
        } == prefixIDs + ["b-input"] + currentIDs + (reusesInferredRun ? [] : ["foreign-answer"]))
        if !foldsEarlier { #expect(Array(settled.prefix(prefix.count)) == Array(raw.prefix(prefix.count))) }
        for message in decoded where message.transcriptMessageID?.hasPrefix("foreign-") == true {
            #expect(settled.contains(.message(message)))
        }
        #expect(ChatTranscriptRow.collapseCompletedWork(settled, runWorking: false) == settled)
    }
}
